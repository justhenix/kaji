import assert from 'node:assert/strict';
import {resolve,sep} from 'node:path';
// @ts-ignore Playwright is installed in the web workspace.
import {chromium} from '../../web/node_modules/@playwright/test/index';

const dist=resolve(import.meta.dir,'../dist');
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/') return new Response('<!doctype html><title>Kaji tracking measurement</title>',{headers:{'content-type':'text/html'}});
  const file=resolve(dist,path.slice(1));
  if(!file.startsWith(dist+sep))return new Response(null,{status:404});
  return await Bun.file(file).exists()?new Response(Bun.file(file)):new Response(null,{status:404});
}});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const context=await browser.newContext({permissions:['camera']});
  const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const samples=await page.evaluate(async()=>{
    const worker=new Worker('/vision.worker.js');
    let stream:MediaStream|undefined;
    const video=document.createElement('video');video.muted=true;video.playsInline=true;
    const response=(timeout=3000)=>new Promise<any>((accept,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Tracking measurement timed out')),timeout);
      worker.onmessage=event=>{clearTimeout(timer);event.data.type==='error'?reject(new Error(event.data.error)):accept(event.data);};
      worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message));};
    });
    try{
      const ready=response(15000);worker.postMessage({type:'init',wasm:new URL('/wasm',location.href).href,model:new URL('/face_landmarker.task',location.href).href});await ready;
      stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:480},height:{ideal:360},frameRate:{ideal:30,max:30}},audio:false});
      video.srcObject=stream;await video.play();
      const samples:any[]=[];
      const started=performance.now();
      while(performance.now()-started<10_000){
        await new Promise<void>((accept,reject)=>{const timer=setTimeout(()=>reject(new Error('Camera stopped producing frames')),3000);video.requestVideoFrameCallback(()=>{clearTimeout(timer);accept();});});
        const captured=performance.now(),bitmap=await createImageBitmap(video),pose=response();
        worker.postMessage({type:'frame',bitmap,captured,timestamp:captured},[bitmap]);
        const result=await pose;samples.push({ms:captured-started,faces:result.faces,candidates:result.candidates});
      }
      return samples;
    }finally{stream?.getTracks().forEach(track=>track.stop());video.pause();video.srcObject=null;worker.terminate();}
  });
  const poses=samples.flatMap((sample:any)=>sample.faces===1&&sample.candidates.length===1?[{ms:sample.ms,...sample.candidates[0]}]:[]);
  assert(poses.length>=20,'Too few unambiguous face observations');
  const percentile=(values:number[],q:number)=>values.sort((a,b)=>a-b)[Math.floor((values.length-1)*q)]!;
  const deltas=poses.slice(1).map((pose:any,i:number)=>Math.hypot(pose.yaw-poses[i].yaw,pose.pitch-poses[i].pitch));
  const summary={samples:samples.length,usable:poses.length,seconds:poses.at(-1)!.ms/1000,rawDeltaMedian:percentile(deltas,.5),rawDeltaP95:percentile(deltas,.95),yawSpan90:percentile(poses.map((p:any)=>p.yaw),.95)-percentile(poses.map((p:any)=>p.yaw),.05),pitchSpan90:percentile(poses.map((p:any)=>p.pitch),.95)-percentile(poses.map((p:any)=>p.pitch),.05)};
  await Bun.write(resolve(import.meta.dir,'../verification/head-still-measurement.json'),JSON.stringify({time:new Date().toISOString(),summary,samples},null,2));
  console.log(JSON.stringify(summary));
}finally{await browser.close();server.stop(true);}
