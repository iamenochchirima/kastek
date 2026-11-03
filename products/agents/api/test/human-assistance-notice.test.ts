import {expect,it} from 'vitest';
import {humanAssistanceNotice} from '../src/product/inbox/human-assistance';

it('keeps the factual receipt short and leaves conversational questions to the agent',()=>{
 const notice=humanAssistanceNotice({hours:{state:'closed',timeZone:'Africa/Johannesburg',intervals:[]},nextOpening:'2026-11-03T23:00:00.000Z',staffAvailability:'unknown',responseTime:'unknown'});
 expect(notice).toContain('Wed 4 Nov, 01:00');
 expect(notice).toContain('Africa/Johannesburg');
 expect(notice).toContain('still help');
 expect(notice.length).toBeLessThan(180);
 expect(notice).not.toContain('?');
 expect(notice).not.toContain('contact details');
});
