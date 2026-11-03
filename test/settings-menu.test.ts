import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramRequest } from '../src/bot.ts';
import { applyTelegramCommand } from '../src/telegram-settings.ts';
import { alertText, initialState } from '../src/alerts.ts';
import { renderBriefSnapshot } from '../src/snapshot.ts';
import { config, harness, json } from './helpers.ts';

// Synthetic owner/chat/configuration, measurements and intercepted services only.
function setup(extra = {}) {
  const c=config({telegram:{enabled:true},...extra}),h=harness(c),secret='synthetic-webhook-secret-1234567890';
  const env={...h.env,TELEGRAM_OWNER_ID:'789',TELEGRAM_WEBHOOK_SECRET:secret};let id=0;
  h.hook(url=>url.endsWith('/answerCallbackQuery')?json({ok:true}):undefined);
  const send=(input:string,callback=false,owner=789)=>handleTelegramRequest(new Request('https://synthetic.invalid/telegram/webhook',{
    method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:++id,
      ...(callback?{callback_query:{id:'synthetic-callback',from:{id:owner},data:input,message:{chat:{id:456},text:'/full off'}}}:
        {message:{from:{id:owner},chat:{id:456},date:Math.floor(h.clock.time/1000),text:input}})})}),env,h.deps);
  const buttons=()=>JSON.parse(String(h.calls.filter(x=>x.url.endsWith('/sendMessage')).at(-1)?.init?.body)).reply_markup?.inline_keyboard?.flat()??[];
  const find=(prefix:string)=>{const b=buttons().find((b:{callback_data:string})=>b.callback_data.startsWith(prefix));assert(b,`Missing ${prefix} button`);return b.callback_data as string;};
  const state=()=>JSON.parse(h.kv.data.get('telegram:v1')!);
  return {...h,c,send,buttons,find,state};
}
test('settings offers kW presets and preview needs explicit confirmation before changing overrides',async()=>{
  const h=setup();await h.send('/settings');
  assert.match(h.sent.at(-1)!,/above 0.3 kW/);
  assert(h.buttons().some((b:{text:string})=>b.text==='0.5 kW'));
  assert(h.buttons().every((b:{callback_data:string})=>Buffer.byteLength(b.callback_data)<=64));
  h.advance(2000);await h.send(h.find('pref:pick:500:'),true);
  assert.match(h.sent.at(-1)!,/0.5 kW/);assert.match(h.sent.at(-1)!,/house battery/i);
  assert.equal(h.state().overrides,undefined);
  const confirm=h.find('pref:save:500:');h.advance(2000);await h.send(confirm,true);
  assert.equal(h.state().overrides.dischargeWatts,500);assert.equal(h.state().overrides.dischargeRearmWatts,100);
  assert.equal(h.kv.puts.filter(x=>x.key==='monitor:v1').length,0);
  assert.equal(h.calls.filter(x=>!x.url.includes('api.telegram.org')).length,0);
  h.advance(2000);await h.send(confirm,true);assert.match(h.sent.at(-1)!,/expired|changed/i);
});
test('cancel leaves preferences untouched and lower-than-rearm presets are omitted',async()=>{
  const h=setup({dischargeWatts:2000,dischargeRearmWatts:750});await h.send('/settings');
  assert(!h.buttons().some((b:{text:string})=>b.text==='0.5 kW'));
  h.advance(2000);await h.send(h.find('pref:pick:1000:'),true);
  h.advance(2000);await h.send(h.find('pref:cancel:'),true);
  assert.equal(h.state().overrides,undefined);assert.match(h.sent.at(-1)!,/cancelled/i);
});
test('expired, future and changed-context settings menus cannot save',async()=>{
  for(const kind of ['expired','future','changed']){
    const h=setup();await h.send('/settings');const data=h.find('pref:pick:500:');
    if(kind==='expired')h.advance(1800000);
    else if(kind==='future')h.clock.time-=1;
    else{h.advance(2000);await h.send('/full off');h.advance(2000);}
    // Future callback must still pass the independent rate guard to exercise its age check.
    if(kind==='future'){const s=h.state();s.lastHandledAt=0;h.kv.data.set('telegram:v1',JSON.stringify(s));}
    await h.send(data,true);assert.match(h.sent.at(-1)!,/expired|changed/i);
    assert.equal(h.state().overrides?.dischargeWatts??300,300);
  }
});
test('settings callbacks retain owner authorization and command budget',async()=>{
  const h=setup();await h.send('/settings');const data=h.find('pref:pick:500:');
  h.advance(2000);const before=h.kv.puts.length;assert.equal((await h.send(data,true,999)).status,403);
  assert.equal(h.kv.puts.length,before);
  const state=h.state();state.used=47;h.kv.data.set('telegram:v1',JSON.stringify(state));
  await h.send(data,true);assert.match(h.sent.at(-1)!,/Daily command limit/);assert.equal(h.state().overrides,undefined);
});
test('custom kW text converts exactly to watts and rejects unsafe precision or rearm crossing',()=>{
  const c=config();const result=applyTelegramCommand(c,'/discharge_kw 0.472');
  assert.equal(result.changed,true);assert.equal(result.config.dischargeWatts,472);
  for(const value of ['0','0.1','0.0001','NaN','1e3','-1','Infinity','9999999']){
    assert.equal(applyTelegramCommand(c,'/discharge_kw '+value).changed,false);
  }
  assert.equal(applyTelegramCommand(c,'/discharge_watts 472').config.dischargeWatts,472);
});
test('battery alerts and brief snapshots display kW without claiming measured EV power',()=>{
  const c=config(),at=Date.now(),reading={at,soc:80,dischargeWatts:472};
  const text=alertText({kind:'discharge',id:'synthetic',createdAt:at,attempts:0,nextAttemptAt:at,reading},c);
  assert.match(text,/Battery discharge: 0.472 kW/);assert.match(text,/Above 0.3 kW/);
  assert.match(renderBriefSnapshot({...initialState(c),latestReading:reading,lastReadingAt:at},c,at),/Battery discharge: 0.472 kW/);
});
test('installations above all preset rearm values keep a usable text-only settings view',async()=>{
  const h=setup({dischargeWatts:5000,dischargeRearmWatts:4000});await h.send('/settings');
  const last=JSON.parse(String(h.calls.at(-1)?.init?.body));
  assert.equal(last.reply_markup,undefined);assert.match(last.text,/\/discharge_kw/);
});
