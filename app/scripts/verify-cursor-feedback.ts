import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {dlopen,FFIType,ptr} from 'bun:ffi';

const flag=process.argv.indexOf('--binary');
const binary=flag<0?resolve(process.env.LOCALAPPDATA!,'Kaji/kaji-diag.exe'):resolve(process.argv[flag+1]!);
const pe=Buffer.from(await Bun.file(binary).arrayBuffer());
assert.equal(pe.readUInt16LE(pe.readUInt32LE(0x3c)+24+68),3,'Repeated UIA checks must use a console-subsystem executable');
const {symbols:win}=dlopen('user32.dll',{
  GetCursorInfo:{args:[FFIType.ptr],returns:FFIType.i32},
  LoadCursorW:{args:[FFIType.ptr,FFIType.ptr],returns:FFIType.ptr},
});
const wait=Number(win.LoadCursorW(null,32514n)),starting=Number(win.LoadCursorW(null,32650n));
assert(wait!==0&&starting!==0&&wait!==starting,'Could not resolve Windows busy-cursor handles');
function sample(){
  const bytes=new Uint8Array(24),view=new DataView(bytes.buffer);view.setUint32(0,24,true);
  assert(win.GetCursorInfo(ptr(bytes)),'Could not read cursor state');
  const handle=Number(view.getBigUint64(8,true));
  return {busy:handle===wait||handle===starting,x:view.getInt32(16,true),y:view.getInt32(20,true)};
}
await Bun.sleep(2500);
const states:boolean[]=[];
let running=true,probes=0;
const observing=(async()=>{while(running){states.push(sample().busy);await Bun.sleep(10);}})();
try{
  for(let i=0;i<20;i++){
    const point=sample();
    const child=Bun.spawn([binary,'--uia-worker',JSON.stringify({kind:'hit_test',point:{x:point.x,y:point.y}})],{stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true,signal:AbortSignal.timeout(2000)});
    const response=JSON.parse(await new Response(child.stdout).text());
    assert.equal(await child.exited,0);
    assert(response.Ok?.kind==='hit_target','Console worker did not return a hit-test result');
    probes++;await Bun.sleep(70);
  }
}finally{running=false;await observing;}
const result={time:new Date().toISOString(),binary,probes,samples:states.length,busySamples:states.filter(Boolean).length,mouseInput:false,camera:false};
await Bun.write(resolve(import.meta.dir,'../verification/cursor-feedback.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
assert.equal(result.busySamples,0,'Repeated helper launches changed the native cursor to a loading state');
