const PREFIX='atable:'+self.registration.scope+':';
const CACHE=PREFIX+'v2';
const FILES=['./','./index.html','./styles.css','./app.js','./drive.js','./meal.js','./storage.js','./config.js','./icon.svg','./manifest.webmanifest','./installation.html'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(PREFIX)&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET' || url.origin!==self.location.origin || !url.href.startsWith(self.registration.scope))return;
  event.respondWith(caches.match(event.request,{cacheName:CACHE}).then(cached=>cached||fetch(event.request)));
});
