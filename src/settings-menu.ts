import type { Config } from './types.ts';
import type { sendTelegram } from './telegram.ts';
import { sha256 } from './deye.ts';
import { kilowatts } from './power.ts';

const presets = [300, 500, 1000, 2000, 3000];
export const SETTINGS_MENU_EXPIRED = 'This settings menu expired or settings changed. Use /settings for a new menu.';
export function settingsMenu(c: Config, now: number) {
  let digest: Promise<string> | undefined;
  const context = () => digest ??= sha256(JSON.stringify([c.region,c.stationId,c.notifications,c.fullSoc,
    c.fullRearmSoc,c.dischargeWatts,c.dischargeRearmWatts,c.daytimeDischarge])).then(s=>s.slice(0,12));
  const data = async (action: string, watts: number, at = now) => `pref:${action}:${watts}:${at}:${await context()}`;
  return {
    async menu(): Promise<Parameters<typeof sendTelegram>[3]> {
      const eligible=presets.filter(w=>w>c.dischargeRearmWatts);
      if(!eligible.length||!Number.isSafeInteger(now)||now<0||now>8.64e15)return undefined;
      return { inline_keyboard: await Promise.all(eligible.map(async watts=>[
        {text:kilowatts(watts),callback_data:await data('pick',watts)}])) };
    },
    async action(raw: string): Promise<{kind:'invalid'|'cancel'|'pick'|'save';watts?:number;markup?:Parameters<typeof sendTelegram>[3]}> {
      const m=/^pref:(pick|save|cancel):(\d{1,4}):(\d{1,16}):([a-f0-9]{12})$/.exec(raw);
      if(!m)return {kind:'invalid'};
      const watts=Number(m[2]),at=Number(m[3]);
      if(!Number.isSafeInteger(now)||!Number.isSafeInteger(at)||String(at)!==m[3]||String(watts)!==m[2]||at>now||now-at>=1800000||
        !presets.includes(watts)||watts<=c.dischargeRearmWatts||m[4]!==await context())return {kind:'invalid'};
      if(m[1]==='pick')return {kind:'pick',watts,markup:{inline_keyboard:[
        [{text:`Confirm ${kilowatts(watts)}`,callback_data:await data('save',watts,at)}],
        [{text:'Cancel',callback_data:await data('cancel',watts,at)}]]}};
      return {kind:m[1] as 'save'|'cancel',watts};
    },
  };
}
