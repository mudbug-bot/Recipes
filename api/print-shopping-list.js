const fs = require('fs/promises');
const path = require('path');

const SITE_ROOT = process.env.SITE_ROOT || 'https://mudbug-recipes.netlify.app';
const PRINTER_EMAIL = process.env.EPSON_PRINTER_EMAIL;
const MAIL_FROM = process.env.MAIL_FROM;
const POSTMARK_SERVER_TOKEN = process.env.POSTMARK_SERVER_TOKEN;
const PRINT_SECRET = process.env.PRINT_SECRET;

function sendJson(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function escapeHtml(value = '') {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtml(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&frac12;/g, '1/2');
}

function stripTags(value = '') {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function normalizePagePath(pagePath) {
  if (typeof pagePath !== 'string') return null;
  const trimmed = pagePath.trim();
  if (!trimmed.startsWith('/Recipes/') || !trimmed.endsWith('-Shopping.html')) return null;
  if (trimmed.includes('..') || trimmed.includes('\\')) return null;
  return trimmed;
}

async function loadShoppingPage(pagePath, requestHost) {
  const relativePath = pagePath.replace(/^\//, '');
  const localPath = path.join(process.cwd(), relativePath);

  try {
    return await fs.readFile(localPath, 'utf8');
  } catch {
    const host = requestHost || new URL(SITE_ROOT).host;
    const url = new URL(pagePath, `https://${host}`);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Could not fetch shopping page (${response.status})`);
    }
    return await response.text();
  }
}

function parseShoppingPage(html, pagePath) {
  const subtitleMatch = html.match(/<div class="shopping-card">[\s\S]*?<h1>Shopping List<\/h1>[\s\S]*?<p[^>]*>(.*?)<\/p>/i);
  const fallbackTitleMatch = html.match(/<p[^>]*>(.*?)<\/p>/i);
  const recipeName = stripTags(
    subtitleMatch ? subtitleMatch[1] : (fallbackTitleMatch ? fallbackTitleMatch[1] : path.basename(pagePath, '.html').replace(/-Shopping$/, '').replace(/-/g, ' '))
  );

  const sections = [...html.matchAll(/<div class="section">([\s\S]*?)<\/div>/g)].map((match) => {
    const sectionHtml = match[1];
    const headingMatch = sectionHtml.match(/<h2>(.*?)<\/h2>/i);
    const items = [...sectionHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((itemMatch) => stripTags(itemMatch[1]));
    return {
      title: stripTags(headingMatch ? headingMatch[1] : 'Items'),
      items,
    };
  }).filter(section => section.items.length);

  if (!sections.length) {
    throw new Error('Shopping list sections were not found');
  }

  return { recipeName, sections };
}

function buildTextBody({ recipeName, sections }) {
  const lines = [`Shopping List: ${recipeName}`, ''];
  for (const section of sections) {
    lines.push(section.title);
    for (const item of section.items) {
      lines.push(`[ ] ${item}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function buildHtmlBody({ recipeName, sections }) {
  const renderedSections = sections.map(section => `
    <div style="margin:10px 0 12px; page-break-inside:avoid;">
      <h2 style="font-size:14px; line-height:1.2; color:#2B547E; border-bottom:1px solid #2B547E; padding-bottom:3px; margin:0 0 5px; font-weight:700;">${escapeHtml(section.title)}</h2>
      <ul style="list-style:none; padding:0; margin:0;">
        ${section.items.map(item => `<li style="padding:2px 0; border-bottom:1px solid #eef1f4; font-size:12px; line-height:1.2;">&#x2610; ${escapeHtml(item)}</li>`).join('')}
      </ul>
    </div>`).join('');

  return `<!DOCTYPE html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#34495e; margin:0; padding:12px 14px; max-width:700px; font-size:12px; line-height:1.2;">
    <h1 style="margin:0 0 3px; color:#2c3e50; font-size:18px; line-height:1.15;">Shopping List</h1>
    <p style="margin:0 0 10px; color:#6b7280; font-size:12px; line-height:1.2;">${escapeHtml(recipeName)}</p>
    ${renderedSections}
  </body>
</html>`;
}

async function sendPrintEmail(parsed, sourceUrl) {
  if (!PRINTER_EMAIL || !MAIL_FROM || !POSTMARK_SERVER_TOKEN) {
    throw new Error('Missing Postmark configuration');
  }

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: MAIL_FROM,
      To: PRINTER_EMAIL,
      Subject: `Shopping List - ${parsed.recipeName}`,
      TextBody: buildTextBody(parsed),
      HtmlBody: buildHtmlBody(parsed),
      MessageStream: 'outbound',
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Postmark send failed (${response.status}): ${details}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (PRINT_SECRET) {
    const providedSecret = req.headers['x-print-secret'] || (req.body && req.body.secret);
    if (providedSecret && providedSecret !== PRINT_SECRET) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
  }

  try {
    const pagePath = normalizePagePath(req.body && req.body.pagePath);
    if (!pagePath) {
      return sendJson(res, 400, { error: 'Invalid shopping list path' });
    }

    const html = await loadShoppingPage(pagePath, req.headers.host);
    const parsed = parseShoppingPage(html, pagePath);
    const sourceUrl = new URL(pagePath, SITE_ROOT).toString();

    await sendPrintEmail(parsed, sourceUrl);

    return sendJson(res, 200, { message: 'Sent to printer' });
  } catch (error) {
    console.error('print-shopping-list failed', error);
    return sendJson(res, 500, { error: error.message || 'Print failed' });
  }
};
