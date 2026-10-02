// Drive transport adapted from delzenneloic/tickets-de-caisses.
  const API = 'https://www.googleapis.com/drive/v3';
  const FOLDER = 'application/vnd.google-apps.folder';
  const ROOT_NAME = 'suivi_alimentation';
  const MAX_SIZE = 25 * 1024 * 1024;
  const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff' };
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  function naming(date, extension) {
    const month = `${date.getFullYear()}.${pad(date.getMonth() + 1)}`;
    const stamp = `${month}.${pad(date.getDate())}.${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
    return { month, stamp, name: `${stamp}.${extension}` };
  }
  function fileInfo(file) {
    if (!file.size) throw new Error('Ce fichier est vide.');
    if (file.size > MAX_SIZE) throw new Error('Ce fichier dépasse la limite de 25 Mo.');
    let extension = (file.name.split('.').pop() || '').toLowerCase();
    if (!TYPES[extension]) extension = Object.keys(TYPES).find(key => TYPES[key] === file.type);
    if (!extension) throw new Error('Choisissez une photo.');
    return { extension, mimeType: TYPES[extension] };
  }
  const queryEscape = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  class DriveError extends Error {
    constructor(status, detail = {}) {
      const reason = detail.error?.errors?.[0]?.reason || '';
      let message = `Google Drive a refusé la demande (${status}). Réessayez.`;
      if (status === 401) message = 'La connexion Google a expiré. Reconnectez-vous puis relancez l’envoi.';
      else if (status === 404) message = 'Le dossier est introuvable ou inaccessible. Vérifiez votre compte et la corbeille Drive, puis réessayez.';
      else if (reason === 'storageQuotaExceeded') message = 'Votre Google Drive est plein. Libérez de l’espace puis réessayez.';
      else if (status === 429 || /[Rr]ateLimit/.test(reason)) message = 'Google reçoit trop de demandes. Patientez un instant puis réessayez.';
      else if (status === 403) message = 'Accès Drive refusé. Vérifiez l’autorisation accordée à l’application et l’activation de Google Drive API.';
      else if (status >= 500) message = 'Google Drive est momentanément indisponible. Réessayez.';
      super(message); this.status = status;
    }
  }
  class Drive {
    constructor({ getToken, fetcher = (...args) => fetch(...args), onExpired = () => {} }) {
      this.getToken = getToken; this.fetcher = fetcher; this.onExpired = onExpired;
      this.folders = new Map();
    }
    async request(url, options = {}, allowed = []) {
      const token = this.getToken();
      if (!token) { this.onExpired(); throw new DriveError(401); }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      let response;
      try {
        response = await this.fetcher(url, { ...options, signal: controller.signal, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
      } catch (error) {
        throw new Error(error.name === 'AbortError' ? 'L’envoi a pris trop de temps. Votre repas est conservé ; réessayez.' : 'Connexion interrompue. Votre repas est conservé ; réessayez.');
      } finally { clearTimeout(timer); }
      if (response.status === 401) this.onExpired();
      if (!response.ok && !allowed.includes(response.status)) {
        let detail = {}; try { detail = await response.json(); } catch {}
        throw new DriveError(response.status, detail);
      }
      return response;
    }
    async account() {
      const data = await (await this.request(`${API}/about?fields=user(permissionId,emailAddress,displayName)`)).json();
      if (!data.user?.permissionId) throw new Error('Impossible d’identifier le compte Google. Reconnectez-vous.');
      return data.user;
    }
    async generatedId() {
      const data = await (await this.request(`${API}/files/generateIds?count=1&space=drive&type=files`)).json();
      if (!data.ids?.[0]) throw new Error('Google n’a pas fourni d’identifiant de fichier. Réessayez.');
      return data.ids[0];
    }
    async folder(name, parent = 'root') {
      const key = `${parent}/${name}`;
      if (this.folders.has(key)) return this.folders.get(key);
      const q = `name='${queryEscape(name)}' and mimeType='${FOLDER}' and '${queryEscape(parent)}' in parents and trashed=false`;
      const params = new URLSearchParams({ q, spaces: 'drive', fields: 'files(id)', orderBy: 'createdTime', pageSize: '100' });
      const data = await (await this.request(`${API}/files?${params}`)).json();
      let id = data.files?.[0]?.id;
      if (!id) {
        const folder = await (await this.request(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) })).json();
        id = folder.id;
      }
      if (!id) throw new Error('Impossible de créer le dossier Google Drive.');
      this.folders.set(key, id);
      return id;
    }
    async findUploaded(item) {
      const response = await this.request(`${API}/files/${encodeURIComponent(item.driveId)}?fields=id,name,size,trashed,parents,appProperties`, {}, [404]);
      if (response.status === 404) return null;
      const remote = await response.json();
      if (remote.trashed) throw new Error('Ce fichier est dans la corbeille Drive. Restaurez-le avant de réessayer.');
      if (Number(remote.size) !== item.size || remote.appProperties?.artifactId !== item.id || remote.name !== item.name || !remote.parents?.includes(item.folderId)) throw new Error('Le fichier distant ne correspond pas au fichier attendu. Vérifiez-le dans Drive.');
      return remote;
    }
    validSession(url) {
      try { const parsed = new URL(url); return parsed.origin === 'https://www.googleapis.com' && parsed.pathname.startsWith('/upload/drive/v3/files'); }
      catch { return false; }
    }
    async upload(item, persist, progress = () => {}) {
      // Identifiant fixé et enregistré avant toute création : une réponse perdue ne duplique pas le fichier.
      if (!item.driveId) { item.driveId = await this.generatedId(); await persist(item); }
      const existing = await this.findUploaded(item);
      if (existing) return existing;
      let offset = 0;
      if (item.sessionUrl && this.validSession(item.sessionUrl)) {
        const status = await this.request(item.sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${item.size}` }, body: new Blob([]) }, [308, 404, 410]);
        if (status.ok) return status.json();
        if (status.status === 308) offset = this.nextOffset(status, item.size);
        else { item.sessionUrl = null; await persist(item); }
      } else item.sessionUrl = null;
      if (!item.sessionUrl) {
        const metadata = { id: item.driveId, name: item.name, mimeType: item.mimeType, parents: [item.folderId], appProperties: { artifactId: item.id } };
        const response = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': item.mimeType, 'X-Upload-Content-Length': String(item.size) }, body: JSON.stringify(metadata) }, [409]);
        if (response.status === 409) {
          const remote = await this.findUploaded(item);
          if (remote) return remote;
          throw new Error('L’envoi précédent est encore en cours. Réessayez dans un instant.');
        }
        const sessionUrl = response.headers.get('Location');
        if (!this.validSession(sessionUrl)) throw new Error('Google n’a pas fourni d’adresse d’envoi valide. Réessayez.');
        item.sessionUrl = sessionUrl; await persist(item);
      }
      const chunkSize = 1024 * 1024; // Multiple de 256 Ko, requis par Drive.
      while (offset < item.size) {
        progress(Math.floor(offset / item.size * 100));
        const end = Math.min(offset + chunkSize, item.size);
        const response = await this.request(item.sessionUrl, { method: 'PUT', headers: { 'Content-Type': item.mimeType, 'Content-Range': `bytes ${offset}-${end - 1}/${item.size}` }, body: item.blob.slice(offset, end) }, [308]);
        if (response.ok) return response.json();
        const next = this.nextOffset(response, item.size);
        if (next <= offset) throw new Error('L’envoi n’a pas progressé. Votre repas est conservé ; réessayez.');
        offset = next;
      }
      const remote = await this.findUploaded(item);
      if (!remote) throw new Error('La confirmation Drive n’est pas encore disponible. Réessayez.');
      return remote;
    }
    nextOffset(response, size) {
      const range = response.headers.get('Range');
      if (!range) return 0;
      const match = /^bytes=0-(\d+)$/i.exec(range);
      const next = match ? Number(match[1]) + 1 : NaN;
      if (!Number.isSafeInteger(next) || next < 0 || next > size) throw new Error('Réponse d’envoi Google invalide. Réessayez.');
      return next;
    }
  }

export { naming, fileInfo, queryEscape, DriveError, Drive, ROOT_NAME, MAX_SIZE };

