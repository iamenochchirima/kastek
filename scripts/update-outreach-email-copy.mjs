import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('local-work/outreach-emails');

const FOUNDER_LINE =
  'My name is Enock Chirima, founder of KasiTek, an AI automation and business growth consultancy based in South Africa, offering practical solutions at affordable prices.';

const SERVICES_AND_NO_TECH = [
  'We help businesses with:',
  '',
  'AI Agents',
  '1) WhatsApp AI Agent (from R2,500 setup | R300/mo)',
  '2) Website AI Agent (from R2,500 setup | R300/mo)',
  '3) Facebook Messenger AI Agent',
  '4) AI Voice Agent',
  '',
  'Growth Systems',
  '1) WhatsApp Bulk Messaging (high-volume campaigns with 2,000+ messages/day capacity, subject to platform limits)',
  '2) Meta Business Verification Support',
  '3) Lead Capture and Follow-up Automation',
  '4) Enquiry Routing and Response Automation',
  '',
  'Web Presence',
  '1) Website updates and revamps',
  '2) Conversion-focused landing pages',
  '3) UX/content improvements for better conversion',
  '',
  'Custom quote available for services without listed pricing.',
  '',
  'No technical setup on your side, no long-term contracts, go live in 3-7 days.',
  ''
].join('\n');

const CTA_BLOCK = [
  'Try our AI agents yourself:',
  'WhatsApp Agent: https://wa.me/+27761073792',
  'Website AI Agent: https://kasitek.co.za',
  '',
  'Find out more or get a quote on: https://kasitek.co.za',
  ''
].join('\n');

const report = {
  scanned_files: 0,
  files_with_email_body: 0,
  files_updated: 0,
  emails_updated: 0,
  errors: []
};

function listJsonFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFiles(full));
    else if (entry.isFile() && full.endsWith('.json')) out.push(full);
  }
  return out;
}

function transformBody(body, businessName) {
  let text = String(body).replace(/\r\n/g, '\n');
  const original = text;
  if (text.includes('\\n') && !text.includes('\n')) {
    text = text.replace(/\\n/g, '\n');
  }

  text = text.replace(/Founder,\s*KasiAI/g, 'Founder, KasiTek');
  text = text.replace(/\bKasiAI\b/g, 'KasiTek');

  text = text.replace(/My name is Enock Chirima,[^\n]*/g, FOUNDER_LINE);
  const founderMatch = text.match(/My name is Enock Chirima,[^\n]*/);
  if (founderMatch && founderMatch.index !== undefined) {
    const founderStart = founderMatch.index;
    const founderEnd = founderStart + founderMatch[0].length;
    const beforeFounder = text.slice(0, founderStart);
    const afterFounder = text.slice(founderEnd);

    const warmIdx = afterFounder.indexOf('\n\nWarm regards,');
    if (warmIdx !== -1) {
      const beforeWarm = afterFounder.slice(0, warmIdx);
      const afterWarm = afterFounder.slice(warmIdx);
      const tailMatch = beforeWarm.match(/\n\n(?:If\b|Happy to\b|If useful\b|I['’]d love\b|Would you be open\b)[\s\S]*$/i);
      const customTail = tailMatch ? tailMatch[0] : '';

      text = [
        beforeFounder.trimEnd(),
        '',
        FOUNDER_LINE,
        '',
        SERVICES_AND_NO_TECH,
        CTA_BLOCK,
        customTail.trimStart(),
        '',
        afterWarm.trimStart()
      ].join('\n');
    } else {
      const fallbackTail = `If you're open to it, I can share a short no-obligation automation plan tailored to ${businessName || 'your business'}.`;
      text = [
        beforeFounder.trimEnd(),
        '',
        FOUNDER_LINE,
        '',
        SERVICES_AND_NO_TECH,
        CTA_BLOCK,
        fallbackTail,
        '',
        'Warm regards,',
        'Enock Chirima',
        'Founder, KasiTek',
        'https://kasitek.co.za | +27 73 123 1909'
      ].join('\n');
    }
  }

  text = text.replace(/https?:\/\/kasiai\.site/gi, 'https://kasitek.co.za');
  text = text.replace(/\bkasiai\.site\b/gi, 'https://kasitek.co.za');

  text = text.replace(/^kasitek\.co\.za \| \+27 73 123 1909$/m, 'https://kasitek.co.za | +27 73 123 1909');
  text = text.replace(/^https?:\/\/kasitek\.co\.za \| \+27 73 123 1909$/m, 'https://kasitek.co.za | +27 73 123 1909');

  text = text.replace(/\bAI WhatsApp Agent\b/g, 'WhatsApp AI Agent');
  text = text.replace(/\bAI Website Agent\b/g, 'Website AI Agent');
  text = text.replace(/\bAI Facebook Messenger Agent\b/g, 'Facebook Messenger AI Agent');

  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trimEnd();

  return { text, changed: text !== original };
}

function walkAndTransform(node, stats) {
  if (Array.isArray(node)) {
    node.forEach((v) => walkAndTransform(v, stats));
    return;
  }
  if (!node || typeof node !== 'object') return;

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (key === 'email_body' && typeof value === 'string') {
      const { text, changed } = transformBody(value, node.business_name);
      if (changed) {
        node[key] = text;
        stats.updatedEmails += 1;
      }
      stats.hasEmailBody = true;
    } else {
      walkAndTransform(value, stats);
    }
  }
}

const files = listJsonFiles(ROOT);
report.scanned_files = files.length;

for (const file of files) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    const stats = { updatedEmails: 0, hasEmailBody: false };
    walkAndTransform(json, stats);

    if (stats.hasEmailBody) report.files_with_email_body += 1;
    if (stats.updatedEmails > 0) {
      report.files_updated += 1;
      report.emails_updated += stats.updatedEmails;
      fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    }
  } catch (error) {
    report.errors.push({ file, error: String(error?.message || error) });
  }
}

const reportPath = path.join(ROOT, 'update-report-2026-03-06.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log(`report_path=${reportPath}`);
