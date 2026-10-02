import { naming, ROOT_NAME } from './drive.js';
export const TYPES = { breakfast:'Petit-déjeuner', lunch:'Déjeuner', dinner:'Dîner', snack:'Collation', other:'Autre repas' };
export function localISO(date) {
  const offset = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0,-1);
  return `${local}${offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')}:${String(Math.abs(offset)%60).padStart(2,'0')}`;
}
export function newMeal(now = new Date()) {
  const hour = now.getHours();
  return { id:crypto.randomUUID(), createdAt:now.toISOString(), eatenAt:localISO(now), timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, type:hour < 11 ? 'breakfast' : hour < 15 ? 'lunch' : hour < 18 ? 'snack' : 'dinner', comment:'', photos:[] };
}
export function validateMeal(meal) {
  if (!Number.isFinite(new Date(meal.eatenAt).getTime())) throw new Error('Indique une date et une heure valides.');
  if (!TYPES[meal.type]) throw new Error('Choisis le type de repas.');
  if (!meal.photos.length && !meal.comment.trim()) throw new Error('Ajoute une photo ou quelques mots sur ton repas.');
  if (meal.photos.length > 20) throw new Error('Un repas peut contenir jusqu’à 20 photos.');
}
export function prepareMeal(draft) {
  validateMeal(draft);
  const meal = structuredClone(draft);
  // Use the stored local time, independent of the timezone during a later retry.
  const parts = meal.eatenAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
  if (!parts) throw new Error('Date du repas invalide.');
  meal.stamp = parts.slice(1).join('.');
  meal.month = parts.slice(1,3).join('.');
  meal.status = 'pending';
  meal.queuedAt = new Date().toISOString();
  meal.photos.forEach((photo,index) => { photo.sequence=index+1; photo.name=`${meal.stamp}_${index+1}.${photo.extension}`; });
  return meal;
}
export function manifest(meal) {
  return {
    schema_version:1,
    meal_id:meal.id,
    meal_type:meal.type,
    eaten_at:meal.eatenAt,
    timezone:meal.timezone,
    recorded_at:meal.createdAt,
    submitted_at:meal.queuedAt,
    comment:meal.comment.trim(),
    drive_path:`${ROOT_NAME}/${meal.month}`,
    photos:meal.photos.map(p=>({sequence:p.sequence,filename:p.name,description:p.description.trim(),drive_file_id:p.driveId,mime_type:p.mimeType,bytes:p.size,added_at:p.addedAt,original_filename:p.originalName}))
  };
}
export async function sendMeal(meal, drive, persist, progress = () => {}) {
  const user = await drive.account();
  if (meal.accountId && meal.accountId !== user.permissionId) throw new Error(`Ce repas doit être envoyé avec le compte ${meal.accountEmail || 'du premier envoi'}. Reconnecte ce compte dans les réglages.`);
  meal.accountId=user.permissionId; meal.accountEmail=user.emailAddress;
  await persist(meal);
  if (!meal.rootId) { meal.rootId=await drive.folder(ROOT_NAME); await persist(meal); }
  if (!meal.folderId) { meal.folderId=await drive.folder(meal.month,meal.rootId); await persist(meal); }
  for (const photo of meal.photos) {
    photo.folderId=meal.folderId;
    progress(`Photo ${photo.sequence}/${meal.photos.length}`);
    await drive.upload(photo,()=>persist(meal),percent=>progress(`Photo ${photo.sequence}/${meal.photos.length} · ${percent} %`));
    // Verify the persisted artifact even after a successful upload response.
    if (!await drive.findUploaded(photo)) throw new Error('La confirmation d’une photo manque. Réessaie l’envoi.');
  }
  if (!meal.document) {
    const blob=new Blob([JSON.stringify(manifest(meal),null,2)+'\n'],{type:'application/json'});
    meal.document={id:meal.id,blob,size:blob.size,name:`${meal.stamp}.json`,mimeType:'application/json',folderId:meal.folderId};
    await persist(meal);
  }
  progress('Enregistrement du repas…');
  // The JSON is the commit marker: it appears only after every photo is confirmed.
  await drive.upload(meal.document,()=>persist(meal));
  if (!await drive.findUploaded(meal.document)) throw new Error('La confirmation du repas manque. Réessaie l’envoi.');
  meal.status='done'; meal.sentAt=new Date().toISOString(); meal.error='';
  for (const photo of meal.photos) { delete photo.blob; delete photo.sessionUrl; }
  delete meal.document.blob; delete meal.document.sessionUrl;
  await persist(meal);
  return meal;
}
