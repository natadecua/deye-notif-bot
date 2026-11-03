import {test} from 'node:test';import assert from 'node:assert/strict';
import {handleTelegramRequest} from '../src/bot.ts';import {decodeBotState} from '../src/bot-state.ts';
import {config,harness,json} from './helpers.ts';
// Synthetic complete choices only; no personal settings or live services.
function setup(){const c=config({telegram:{enabled:true}}),h=harness(c),secret='synthetic-webhook-secret-1234567890';let id=0;
 const env={...h.env,TELEGRAM_OWNER_ID:'789',TELEGRAM_WEBHOOK_SECRET:secret};
 h.hook(url=>url.endsWith('/answerCallbackQuery')?json({ok:true}):undefined);
 const send=(text:string,callback=false,owner=789)=>handleTelegramRequest(new Request('https://synthetic.invalid/telegram/webhook',{
 method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:++id,...(callback?{callback_query:{id:'synthetic',from:{id:owner},data:text,message:{chat:{id:456}}}}:{message:{from:{id:owner},chat:{id:456},date:Math.floor(h.clock.time/1000),text}})})}),env,h.deps);
 const data=(prefix:string)=>{const body=JSON.parse(String(h.calls.filter(x=>x.url.endsWith('/sendMessage')).at(-1)!.init!.body));const b=body.reply_markup.inline_keyboard.flat().find((x:{callback_data:string})=>x.callback_data.startsWith(prefix));assert(b);return b.callback_data as string;};
 return {...h,c,env,send,data,state:()=>decodeBotState(h.kv.data.get('telegram:v1')!,c)};
}
test('reserve setup previews complete explicit values and confirms all-hours consent before persistence',async()=>{
 const h=setup();await h.send('/reserve_set 13 15 5');assert.match(h.sent.at(-1)!,/all hours/);assert.equal(h.state().overrides,undefined);
 const save=h.data('rs:save:');assert(Buffer.byteLength(save)<=64);h.advance(2000);await h.send(save,true);
 assert.deepEqual(h.state().overrides?.reserve,{enabled:true,warnSoc:13,rearmSoc:15,minimumMinutes:5,allHoursConfirmed:true});
 assert(!h.kv.puts.some(p=>p.key==='monitor:v1'));assert(!h.calls.some(x=>!x.url.includes('api.telegram.org')));
 h.advance(2000);await h.send(save,true);assert.match(h.sent.at(-1)!,/expired|changed/i);
});
test('reserve cancellation, original expiry, policy changes and unauthorized owner cannot enable it',async()=>{
 const h=setup();await h.send('/reserve_set 13 15 5');const save=h.data('rs:save:'),cancel=h.data('rs:cancel:');h.advance(2000);
 const writes=h.kv.puts.length;assert.equal((await h.send(save,true,999)).status,403);assert.equal(h.kv.puts.length,writes);
 await h.send(cancel,true);assert.equal(h.state().overrides,undefined);h.advance(1800000);await h.send(save,true);assert.match(h.sent.at(-1)!,/expired|changed/i);
 const j=setup();await j.send('/reserve_set 13 15 5');const old=j.data('rs:save:');j.advance(2000);await j.send('/reserve off');j.advance(2000);await j.send(old,true);assert.equal(j.state().overrides?.reserve?.enabled,false);
});
test('incomplete or invalid reserve choices never pick missing values and reset restores deployment preferences',async()=>{
 const h=setup();for(const input of ['/reserve_set 13','/reserve_set 13 13 5','/reserve_set 13 15 0','/reserve_set 13.5 15 5']){
 await h.send(input);h.advance(2000);assert.equal(h.state().overrides,undefined);}
 await h.send('/reserve_set 13 15 5');h.advance(2000);await h.send(h.data('rs:save:'),true);h.advance(2000);await h.send('/settings reset');assert.equal(h.state().overrides,undefined);
});
