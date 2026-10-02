export const STORAGE_NAME = 'suivi-alimentation:' + new URL('./',location.href).pathname;
let db;
export function openStorage() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(STORAGE_NAME,1);
    request.onupgradeneeded=()=>{ for(const name of ['draft','meals']) request.result.createObjectStore(name,{keyPath:'id'}); };
    request.onsuccess=()=>{ db=request.result;db.onversionchange=()=>db.close();resolve(); };
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('Ferme les autres onglets du journal puis recharge la page.'));
  });
}
function transaction(stores,mode,operation) {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(stores,mode);
    let request;
    try { request=operation(tx); } catch(error){tx.abort();reject(error);return;}
    tx.oncomplete=()=>resolve(request?.result);
    tx.onerror=tx.onabort=()=>reject(new Error('Le stockage de cet appareil est indisponible ou plein. Garde cette page ouverte et libère de l’espace avant de réessayer.'));
  });
}
export const getDraft = async()=> (await transaction(['draft'],'readonly',tx=>tx.objectStore('draft').getAll()))[0];
export const saveDraft = draft=>transaction(['draft'],'readwrite',tx=>tx.objectStore('draft').put(structuredClone(draft)));
export const getMeals = ()=>transaction(['meals'],'readonly',tx=>tx.objectStore('meals').getAll());
export const saveMeal = meal=>transaction(['meals'],'readwrite',tx=>tx.objectStore('meals').put(structuredClone(meal)));
// Moving a draft to the outbox and starting the next draft is one atomic transaction.
export const queueMeal = (meal,next)=>transaction(['draft','meals'],'readwrite',tx=>{
  tx.objectStore('meals').put(structuredClone(meal));
  tx.objectStore('draft').clear();
  return tx.objectStore('draft').put(structuredClone(next));
});
