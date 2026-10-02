import test from 'node:test';
import assert from 'node:assert/strict';
import {Drive,fileInfo} from '../drive.js';
import {newMeal,prepareMeal,manifest,sendMeal} from '../meal.js';

function sample() {
  const meal=newMeal(new Date('2026-10-02T10:30:00.125Z'));
  meal.eatenAt='2026-10-02T12:30:00.125+02:00';meal.timezone='Europe/Brussels';meal.type='lunch';meal.comment='Skyr 200 g, fraises 150 g';
  meal.photos=[1,2].map(n=>({id:`photo-${n}`,originalName:`plat-${n}.jpg`,extension:'jpg',mimeType:'image/jpeg',size:5,blob:new Blob(['photo']),description:n===1?'Skyr 200 g':'Fraises 150 g',addedAt:'2026-10-02T10:30:00Z'}));
  return prepareMeal(meal);
}
function fakeDrive({losePhotoResponse=false,failSecond=false}={}) {
  let counter=0, lost=false, secondFailed=false;
  const files=new Map(),sessions=new Map(),events=[];
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const fetcher=async(url,options={})=>{
    const u=new URL(url), method=options.method||'GET';
    if(u.pathname.endsWith('/about'))return json({user:{permissionId:'account-1',emailAddress:'test@example.invalid'}});
    if(u.pathname.endsWith('/generateIds'))return json({ids:[`id-${++counter}`]});
    if(u.pathname==='/drive/v3/files' && method==='GET')return json({files:[]});
    if(u.pathname==='/drive/v3/files' && method==='POST')return json({id:`folder-${++counter}`});
    if(u.pathname.startsWith('/drive/v3/files/') && method==='GET')return files.has(u.pathname.split('/').pop())?json(files.get(u.pathname.split('/').pop())):json({},404);
    if(u.pathname==='/upload/drive/v3/files' && method==='POST'){
      const metadata=JSON.parse(options.body);events.push({kind:'start',name:metadata.name});
      const session=`https://www.googleapis.com/upload/drive/v3/files?upload_id=${metadata.id}`;
      sessions.set(session,metadata);return new Response('',{status:200,headers:{Location:session}});
    }
    if(method==='PUT' && sessions.has(url)){
      const meta=sessions.get(url);
      if(failSecond && meta.name.endsWith('_2.jpg') && !secondFailed){secondFailed=true;throw new Error('network');}
      if(options.headers['Content-Range'].startsWith('bytes */'))return new Response(null,{status:308});
      const remote={...meta,size:options.body.size,trashed:false};files.set(meta.id,remote);events.push({kind:'finish',name:meta.name});
      if(losePhotoResponse && meta.name.endsWith('_1.jpg') && !lost){lost=true;throw new Error('network response lost');}
      return json(remote);
    }
    throw new Error('Unexpected request '+method+' '+url);
  };
  return {drive:new Drive({getToken:()=> 'test-token',fetcher}),files,events};
}
test('one timestamp, month, sequence and unmodified descriptions per meal',()=>{
  const meal=sample();assert.equal(meal.month,'2026.10');assert.equal(meal.stamp,'2026.10.02.12.30.00.125');
  assert.equal(meal.photos[1].name,'2026.10.02.12.30.00.125_2.jpg');
  assert.equal(manifest(meal).comment,'Skyr 200 g, fraises 150 g');assert.equal(manifest(meal).photos[1].description,'Fraises 150 g');
  const other=sample();other.eatenAt='2026-09-30T23:59:59.999-07:00';assert.equal(prepareMeal(other).month,'2026.09');
});
test('empty meals are rejected; text-only meals accepted; invalid photos rejected',()=>{
  assert.throws(()=>prepareMeal(newMeal()),/Ajoute/);
  const textOnly=newMeal();textOnly.comment='Un café';assert.equal(prepareMeal(textOnly).photos.length,0);
  assert.throws(()=>fileInfo({name:'test.pdf',type:'application/pdf',size:10}),/photo/);
  assert.throws(()=>fileInfo({name:'big.jpg',type:'image/jpeg',size:26*1024*1024}),/25 Mo/);
});
test('JSON is uploaded only after all photos are confirmed and local binaries released',async()=>{
  const {drive,events,files}=fakeDrive();const meal=sample();
  await sendMeal(meal,drive,async()=>{});
  assert.deepEqual(events.filter(e=>e.kind==='finish').map(e=>e.name),[meal.photos[0].name,meal.photos[1].name,meal.document.name]);
  assert.equal(files.size,3);assert.equal(meal.status,'done');assert.equal(meal.photos[0].blob,undefined);
});
test('lost successful response is retried with saved IDs and no duplicate',async()=>{
  const {drive,events,files}=fakeDrive({losePhotoResponse:true});let saved;const persist=async m=>{saved=structuredClone(m);};
  await assert.rejects(sendMeal(sample(),drive,persist),/Connexion interrompue/);
  assert.equal(files.size,1);assert.equal(saved.status,'pending');assert.equal(saved.document,undefined);
  await sendMeal(structuredClone(saved),drive,persist);
  assert.equal(files.size,3);assert.equal(events.filter(e=>e.kind==='start'&&e.name.endsWith('_1.jpg')).length,1);
});
test('second photo failure prevents JSON commit, then resumes',async()=>{
  const {drive,events}=fakeDrive({failSecond:true});let saved;
  await assert.rejects(sendMeal(sample(),drive,async m=>{saved=structuredClone(m);}),/Connexion interrompue/);
  assert.equal(events.some(e=>e.name.endsWith('.json')),false);
  await sendMeal(saved,drive,async()=>{});assert.equal(saved.status,'done');
});
test('a queued meal cannot resume on another Google account',async()=>{
  const {drive,events}=fakeDrive();const meal=sample();meal.accountId='another-account';
  await assert.rejects(sendMeal(meal,drive,async()=>{}),/compte/);assert.equal(events.length,0);
});
test('expired credentials stop before any network write; invalid sessions rejected',async()=>{
  const drive=new Drive({getToken:()=>null,fetcher:()=>{throw new Error('Should not run');}});
  await assert.rejects(drive.account(),/expiré/);
  assert.equal(drive.validSession('https://attacker.invalid/upload/drive/v3/files'),false);
  assert.equal(drive.validSession('https://www.googleapis.com/upload/drive/v3/files?upload_id=x'),true);
});
test('a colliding or altered remote file is not silently accepted',async()=>{
  const drive=new Drive({getToken:()=> 'test',fetcher:async()=>new Response(JSON.stringify({size:5,name:'wrong.jpg',parents:['folder'],appProperties:{artifactId:'photo-1'}}))});
  await assert.rejects(drive.findUploaded({driveId:'remote',id:'photo-1',size:5,name:'expected.jpg',folderId:'folder'}),/correspond pas/);
});
