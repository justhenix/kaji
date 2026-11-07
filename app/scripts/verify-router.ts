import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { gatewayProvider } from '../agent/gateway';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { GATEWAY_MODELS } from '../shared/models';

const token = process.env.KAJI_GATEWAY_TOKEN;
assert(token, 'Runtime owner login is required');
const image = await readFile(new URL('../../web/public/art/cursor.png', import.meta.url));
const results: unknown[] = [];
const modelFlag = process.argv.indexOf('--model');
const selectedModels = modelFlag < 0 ? GATEWAY_MODELS.filter(model => model.id.startsWith('ag/')) : GATEWAY_MODELS.filter(model => model.id === process.argv[modelFlag + 1]);
assert(selectedModels.length > 0, 'Select an enabled model');
for (const selected of selectedModels) {
  const provider = gatewayProvider(token, undefined, selected.id);
  const tool = {name:'report_visual',description:'Return what is visible in the supplied image.',parameters:{type:'object',properties:{subject:{type:'string'},colors:{type:'array',items:{type:'string'}}},required:['subject','colors'],additionalProperties:false}};
  const messages: any[] = [{role:'user',timestamp:Date.now(),content:[
    {type:'text',text:'Inspect the image and call report_visual with its object and its two main non-background colors. After receiving the tool result, reply exactly KAJI_ROUTER_OK.'},
    {type:'image',data:image.toString('base64'),mimeType:'image/png'},
  ]}];
  const first = await (await provider.streamFn(provider.model, normalizeContext({messages,tools:[tool]}), {})).result();
  assert.notEqual(first.stopReason, 'error', first.errorMessage ?? 'Router request failed');
  const call = first.content.find(part => part.type === 'toolCall');
  assert(call?.type === 'toolCall', 'No structured visual tool call returned');
  assert.equal(call.name, 'report_visual');
  const observed = call.arguments as {subject:string;colors:string[]};
  assert(/cursor|pointer|arrow/i.test(observed.subject), 'Wrong image subject');
  assert(/blue/i.test(observed.colors.join(' ')) && /pink|magenta/i.test(observed.colors.join(' ')), 'Wrong image colors');
  messages.push(first, {role:'toolResult',toolCallId:call.id,toolName:call.name,timestamp:Date.now(),isError:false,content:[{type:'text',text:'Visual observations verified. Reply KAJI_ROUTER_OK.'}]});
  const second = await (await provider.streamFn(provider.model, normalizeContext({messages,tools:[tool]}), {})).result();
  assert.notEqual(second.stopReason, 'error', second.errorMessage ?? 'Router continuation failed');
  const reply = second.content.filter(part => part.type === 'text').map(part => part.text).join('');
  assert(reply.includes('KAJI_ROUTER_OK'), 'Tool-result continuation failed');
  const result = {requested:selected.id,vision:true,streaming:true,toolCall:true,toolContinuation:true,reply};
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(new URL(`../../app/verification/${modelFlag < 0 ? 'router' : 'deepseek'}-live.json`, import.meta.url),JSON.stringify({passed:true,time:new Date().toISOString(),results},null,2));
