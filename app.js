import { Drive, fileInfo } from './drive.js';
import { TYPES, newMeal, localISO, prepareMeal, sendMeal } from './meal.js';
import { STORAGE_NAME, openStorage, getDraft, saveDraft, getMeals, saveMeal, queueMeal } from './storage.js';
const $=id=>document.getElementById(id);
const scope='https://www.googleapis.com/auth/drive.file';
let draft, ready=false, busy=false, adding=false, token=null, client=null, authPending=null, persistTail=Promise.resolve(), unsaved=false;
let configuredId=window.MEAL_CONFIG?.googleClientId || '';
try { configuredId=localStorage.getItem(STORAGE_NAME+':client') || configuredId; } catch {}
const previews=new Map();
const drive=new Drive({ getToken:()=>token && token.expires > Date.now()+15000 ? token.value : null, onExpired:()=>{token=null;} });
function feedback(message,error=false) { $('feedback').textContent=message; $('feedback').className='feedback'+(error?' error':''); $('feedback').hidden=!message; }
function controls() {
  $('meal-fields').disabled=!ready || busy || adding;
  $('send-button').disabled=!ready || busy || adding;
  $('retry-button').disabled=!ready || busy || adding || !navigator.onLine;
  $('settings-open').disabled=busy || adding;
  $('send-button').textContent=busy?'Envoi en cours…':adding?'Ajout des photos…':'Envoyer';
  $('auth-state').textContent=token ? 'Google Drive est connecté pour cette session.' : 'Google demandera une connexion si nécessaire.';
}
function connectionBanner() {
  const banner=$('connection-banner'); banner.replaceChildren();
  if (!navigator.onLine) { banner.textContent='Hors ligne. Tu peux noter ton repas ; il sera conservé ici jusqu’à l’envoi.';banner.hidden=false; }
  else if (!configuredId) {
    banner.append('Une première configuration est nécessaire pour envoyer vers Drive.');
    const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent='Configurer Google Drive';button.onclick=openSettings;banner.append(button);banner.hidden=false;
  } else banner.hidden=true;
}
function renderTime() {
  $('meal-time').value=draft.eatenAt.slice(0,16);
  const date=new Date(draft.eatenAt), today=new Date();
  const sameDay=date.toDateString()===today.toDateString();
  $('time-summary').textContent=(sameDay?'Aujourd’hui':date.toLocaleDateString('fr-BE',{day:'numeric',month:'short'}))+' · '+date.toLocaleTimeString('fr-BE',{hour:'2-digit',minute:'2-digit'});
}
function renderDraft() {
  $('meal-type').value=draft.type; $('meal-comment').value=draft.comment; renderTime(); renderPhotos();
}
function refreshEmptyMeal() {
  if(!draft.photos.length && !draft.comment.trim() && !draft.timeEdited && Date.now()-new Date(draft.createdAt).getTime()>300000) {
    const fresh=newMeal();draft.createdAt=fresh.createdAt;draft.eatenAt=fresh.eatenAt;draft.timezone=fresh.timezone;
    if(!draft.typeEdited){draft.type=fresh.type;$('meal-type').value=draft.type;}
    renderTime();
  }
}
function renderPhotos() {
  const ids=new Set(draft.photos.map(p=>p.id));
  for(const [id,url] of previews) if(!ids.has(id)) {URL.revokeObjectURL(url);previews.delete(id);}
  $('photos').replaceChildren();
  draft.photos.forEach((photo,index)=>{
    const card=document.createElement('figure');card.className='photo-card';
    if(!previews.has(photo.id)) previews.set(photo.id,URL.createObjectURL(photo.blob));
    const img=document.createElement('img');img.src=previews.get(photo.id);img.alt=`Photo du plat ${index+1}`;
    img.onerror=()=>{const fallback=document.createElement('p');fallback.className='hint';fallback.style.padding='40px 15px';fallback.textContent='Photo ajoutée · aperçu indisponible sur ce navigateur';img.replaceWith(fallback);};
    const number=document.createElement('span');number.className='photo-number';number.textContent=`${index+1}`;
    const remove=document.createElement('button');remove.type='button';remove.className='remove-photo icon-button';remove.setAttribute('aria-label',`Retirer la photo ${index+1}`);remove.textContent='×';
    remove.onclick=()=>{draft.photos=draft.photos.filter(p=>p.id!==photo.id);scheduleSave();renderPhotos();};
    const label=document.createElement('label');label.htmlFor=`photo-${photo.id}`;label.textContent=`Plat ${index+1} · description facultative`;
    const description=document.createElement('textarea');description.id=label.htmlFor;description.rows=2;description.maxLength=2000;description.placeholder='Aliments, quantités…';description.value=photo.description;
    description.addEventListener('input',()=>{photo.description=description.value;scheduleSave();});
    card.append(img,number,remove,label,description);$('photos').append(card);
  });
  $('photo-empty').hidden=draft.photos.length>0;
  $('photo-count').textContent=`${draft.photos.length} photo${draft.photos.length>1?'s':''}`;
}
function scheduleSave() {
  if(!draft || !ready) return persistTail;
  unsaved=true;$('draft-status').textContent='Sauvegarde du brouillon…';
  const snapshot=structuredClone(draft);
  const operation=persistTail.catch(()=>{}).then(()=>saveDraft(snapshot));
  persistTail=operation;
  operation.then(()=>{if(operation===persistTail){unsaved=false;$('draft-status').textContent='Brouillon enregistré sur cet appareil.';}},error=>{feedback(error.message,true);$('draft-status').textContent='Brouillon non sauvegardé. Garde cette page ouverte.';});
  return operation;
}
async function addPhotos(files) {
  if(!ready || busy || adding) return;
  refreshEmptyMeal();
  adding=true;controls();const errors=[];
  for(const file of files) {
    try {
      if(draft.photos.length>=20) throw new Error('Maximum 20 photos par repas.');
      const info=fileInfo(file);
      draft.photos.push({id:crypto.randomUUID(),originalName:file.name,blob:file,size:file.size,...info,description:'',addedAt:new Date().toISOString()});
      await scheduleSave();
    } catch(error) { errors.push(`${file.name} : ${error.message}`); }
  }
  adding=false;renderPhotos();controls();feedback(errors.join(' '),errors.length>0);
  navigator.storage?.persist?.().catch(()=>{});
}
function initGoogle() {
  client=null;
  if(!configuredId || !window.google?.accounts?.oauth2) return;
  client=google.accounts.oauth2.initTokenClient({
    client_id:configuredId,scope,include_granted_scopes:false,
    callback:response=>{
      const pending=authPending;authPending=null;
      if(response.error || !response.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response,scope)) {
        pending?.reject(new Error('La connexion Google n’a pas été autorisée. Ton repas reste en attente.'));return;
      }
      token={value:response.access_token,expires:Date.now()+Number(response.expires_in)*1000};drive.folders.clear();pending?.resolve();
    },
    error_callback:error=>{const pending=authPending;authPending=null;pending?.reject(new Error(error.type==='popup_closed'?'Connexion annulée. Ton repas reste en attente.':'La fenêtre Google n’a pas pu s’ouvrir. Autorise les fenêtres de connexion puis réessaie.'));}
  });
}
function authenticate() {
  if(token && token.expires>Date.now()+15000) return Promise.resolve();
  if(!configuredId) {openSettings();return Promise.reject(new Error('Configure la connexion à Drive pour envoyer ce repas.'));}
  if(!client) {initGoogle();if(!client)return Promise.reject(new Error('La connexion Google n’est pas encore chargée. Vérifie le réseau puis réessaie.'));}
  return new Promise((resolve,reject)=>{
    authPending={resolve,reject};
    // Synchronous user gesture: do not await storage before requesting the popup.
    try { client.requestAccessToken({prompt:''}); } catch {authPending=null;reject(new Error('Impossible d’ouvrir Google. Recharge la page puis réessaie.'));}
  });
}
async function renderPending() {
  const pending=(await getMeals()).filter(m=>m.status!=='done').sort((a,b)=>a.queuedAt.localeCompare(b.queuedAt));
  $('pending-section').hidden=!pending.length;$('pending-count').textContent=String(pending.length);$('pending-list').replaceChildren();
  for(const meal of pending) {
    const item=document.createElement('article');item.className='pending-item';
    const content=document.createElement('div'), title=document.createElement('strong'), detail=document.createElement('p');
    title.textContent=`${TYPES[meal.type]} · ${new Date(meal.eatenAt).toLocaleString('fr-BE',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`;
    detail.textContent=meal.error || `${meal.photos.length} photo${meal.photos.length>1?'s':''}${meal.comment?' · '+meal.comment.slice(0,100):''}`;
    content.append(title,detail);item.append(content);$('pending-list').append(item);
  }
  return pending;
}
async function flushQueue() {
  const pending=await renderPending();let sent=0;
  for(const meal of pending) {
    try {
      await sendMeal(meal,drive,saveMeal,message=>{$('send-button').textContent=message;$('retry-button').textContent=message;});
      sent++;$('success-link').href=`https://drive.google.com/drive/folders/${encodeURIComponent(meal.folderId)}`;
      $('success').hidden=false;
    } catch(error) {
      meal.error=error.message;
      try {await saveMeal(meal);} catch(storageError){feedback(storageError.message,true);throw storageError;}
      throw error;
    }
  }
  if(sent) feedback(`${sent} repas envoyé${sent>1?'s':''} dans ton Google Drive.`);
}
async function submit(event) {
  event.preventDefault();if(!ready || busy || adding) return;
  let meal;
  try {meal=prepareMeal(draft);} catch(error){feedback(error.message,true);return;}
  busy=true;controls();feedback('');
  const auth=navigator.onLine ? authenticate().then(()=>null,error=>error) : Promise.resolve(new Error('Repas conservé sur cet appareil. Envoie-le quand tu retrouveras une connexion.'));
  try {
    // Retry saving the current snapshot if an earlier storage write failed.
    await scheduleSave();
    const next=newMeal();await queueMeal(meal,next);draft=next;unsaved=false;renderDraft();
    $('draft-status').textContent='Prêt pour le prochain repas.';
    await renderPending();
    const authError=await auth;if(authError)throw authError;
    await flushQueue();
  } catch(error){feedback(error.message,true);}
  finally {busy=false;controls();$('retry-button').textContent='Envoyer les repas en attente';await renderPending();}
}
async function retry() {
  if(busy || adding || !ready || !navigator.onLine) return;
  busy=true;controls();feedback('');
  try {await authenticate();await flushQueue();}
  catch(error){feedback(error.message,true);}
  finally{busy=false;controls();$('retry-button').textContent='Envoyer les repas en attente';await renderPending();}
}
function openSettings() { $('client-id').value=configuredId;controls();$('settings-dialog').showModal(); }
$('settings-open').onclick=openSettings;
$('settings-close').onclick=()=>$('settings-dialog').close();
$('settings-form').onsubmit=event=>{
  event.preventDefault();const next=$('client-id').value.trim();
  if(!/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(next)){$('client-id').setCustomValidity('Indique un identifiant Google valide.');$('client-id').reportValidity();return;}
  try {localStorage.setItem(STORAGE_NAME+':client',next);configuredId=next;token=null;initGoogle();$('settings-dialog').close();connectionBanner();}
  catch {feedback('Les réglages ne peuvent pas être enregistrés dans ce navigateur.',true);}
};
$('client-id').oninput=()=>$('client-id').setCustomValidity('');
$('disconnect-button').onclick=()=>{token=null;drive.folders.clear();controls();feedback('Déconnecté sur cet appareil.');$('settings-dialog').close();};
$('meal-type').onchange=()=>{draft.type=$('meal-type').value;draft.typeEdited=true;refreshEmptyMeal();scheduleSave();};
$('meal-comment').oninput=()=>{refreshEmptyMeal();draft.comment=$('meal-comment').value;scheduleSave();};
$('meal-time').onchange=()=>{
  const value=$('meal-time').value;if(!value)return;
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return;
  date.setMilliseconds(new Date(draft.createdAt).getMilliseconds());
  draft.eatenAt=localISO(date);draft.timeEdited=true;draft.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;renderTime();scheduleSave();
};
$('camera-button').onclick=()=>$('camera-input').click();
$('library-button').onclick=()=>$('library-input').click();
for(const id of ['camera-input','library-input'])$(id).onchange=event=>{const files=[...event.target.files];event.target.value='';addPhotos(files);};
$('meal-form').addEventListener('submit',submit);$('retry-button').onclick=retry;
$('success-close').onclick=()=>$('success').hidden=true;
for(const event of ['online','offline'])window.addEventListener(event,()=>{connectionBanner();controls();});
window.addEventListener('beforeunload',event=>{if(unsaved || adding){event.preventDefault();event.returnValue='';}});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
$('today').textContent=new Intl.DateTimeFormat('fr-BE',{weekday:'long',day:'numeric',month:'long'}).format(new Date()).toUpperCase();
controls();connectionBanner();
async function start() {
  try {await openStorage();draft=await getDraft() || newMeal();refreshEmptyMeal();await saveDraft(draft);ready=true;renderDraft();await renderPending();controls();}
  catch(error){feedback(error.message || 'Le navigateur ne permet pas de sauvegarder les repas. Utilise un navigateur récent hors navigation privée.',true);}
}
if(navigator.locks) {
  navigator.locks.request(STORAGE_NAME+':writer',{ifAvailable:true},async lock=>{
    if(!lock){feedback('Le journal est déjà ouvert dans un autre onglet. Utilise cet onglet ou ferme-le, puis recharge cette page.',true);return;}
    await start();await new Promise(resolve=>window.addEventListener('pagehide',resolve,{once:true}));
  }).catch(error=>feedback(error.message,true));
} else {feedback('Ce navigateur est ancien. Utilise un seul onglet pour ce journal.');start();}
const googleScript=document.createElement('script');googleScript.src='https://accounts.google.com/gsi/client';googleScript.async=true;googleScript.onload=initGoogle;googleScript.onerror=()=>{};document.head.append(googleScript);
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
