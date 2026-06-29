import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';

// ── CORS headers ──
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const postId = url.searchParams.get('id');

    // ── Route: /preview – returns the rendered preview ──
    if (path === '/preview' && postId) {
      return handlePreview(postId, env);
    }

    // ── Route: /readme – returns the README content ──
    if (path === '/readme' && postId) {
      return handleReadme(postId, env);
    }

    // ── Route: /info – returns product info ──
    if (path === '/info' && postId) {
      return handleInfo(postId, env);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

// ── Helper functions receive `env` ──
async function handleInfo(postId, env) {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    const { data: post, error } = await supabase
      .from('posts')
      .select('id, name, file_path, cover, price, user_id')
      .eq('id', postId)
      .single();

    if (error || !post) {
      return jsonResponse({ error: 'Product not found' }, 404);
    }
    return jsonResponse(post);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handlePreview(postId, env) {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

    // 1. Fetch post record
    const { data: post, error: postErr } = await supabase
      .from('posts')
      .select('id, name, file_path')
      .eq('id', postId)
      .single();

    if (postErr || !post) {
      return jsonResponse({ error: 'Product not found' }, 404);
    }
    if (!post.file_path) {
      return jsonResponse({ error: 'No file available' }, 404);
    }

    // 2. Get signed URL
    const { data: signedData, error: signErr } = await supabase
      .storage
      .from('uploads')
      .createSignedUrl(post.file_path, 60);

    if (signErr || !signedData?.signedUrl) {
      return jsonResponse({ error: 'Could not access file' }, 500);
    }

    // 3. Fetch the file
    const resp = await fetch(signedData.signedUrl);
    if (!resp.ok) {
      return jsonResponse({ error: 'Download failed' }, 500);
    }
    const buffer = await resp.arrayBuffer();

    // 4. Check if it's a zip
    const magic = new Uint8Array(buffer.slice(0, 4));
    const isZip = magic[0] === 0x50 && magic[1] === 0x4B;

    if (!isZip) {
      const text = new TextDecoder().decode(buffer);
      if (text.trimStart().startsWith('<')) {
        return jsonResponse({ type: 'html', html: text });
      }
      return jsonResponse({ error: 'Unsupported file format' }, 400);
    }

    // 5. Unzip and process
    const zip = await JSZip.loadAsync(buffer);
    const allFiles = Object.keys(zip.files).filter(f => !zip.files[f].dir);

    // 6. Find entry HTML
    const entryFile = findEntryHTML(allFiles);
    if (!entryFile) {
      return jsonResponse({ error: 'No HTML entry found' }, 404);
    }

    // 7. Build blob map (data URIs)
    const baseDir = entryFile.includes('/') ? entryFile.split('/').slice(0, -1).join('/') + '/' : '';
    const blobMap = {};

    for (const fname of allFiles) {
      const file = zip.files[fname];
      const ext = fname.split('.').pop().toLowerCase();
      const mime = getMime(ext);
      const content = await file.async('arraybuffer');
      const base64 = btoa(String.fromCharCode(...new Uint8Array(content)));
      blobMap[fname] = `data:${mime};base64,${base64}`;
    }

    // 8. Process CSS files (rewrite url() to data URIs)
    const cssFiles = allFiles.filter(f => f.endsWith('.css'));
    for (const cssPath of cssFiles) {
      try {
        const cssContent = await zip.files[cssPath].async('string');
        const rewritten = rewriteCSS(cssContent, baseDir, blobMap);
        blobMap[cssPath] = `data:text/css;base64,${btoa(rewritten)}`;
      } catch (_) { /* keep original */ }
    }

    // 9. Rewrite HTML
    const htmlRaw = await zip.files[entryFile].async('string');
    const rewrittenHtml = rewriteHTML(htmlRaw, baseDir, blobMap, entryFile);

    return jsonResponse({ type: 'html', html: rewrittenHtml });

  } catch (err) {
    console.error('Preview error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleReadme(postId, env) {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    const { data: post, error: postErr } = await supabase
      .from('posts')
      .select('file_path')
      .eq('id', postId)
      .single();

    if (postErr || !post || !post.file_path) {
      return jsonResponse({ error: 'No file found' }, 404);
    }

    const { data: signedData } = await supabase
      .storage
      .from('uploads')
      .createSignedUrl(post.file_path, 60);

    if (!signedData?.signedUrl) {
      return jsonResponse({ error: 'Could not access file' }, 500);
    }

    const resp = await fetch(signedData.signedUrl);
    if (!resp.ok) {
      return jsonResponse({ error: 'Download failed' }, 500);
    }
    const buffer = await resp.arrayBuffer();

    const magic = new Uint8Array(buffer.slice(0, 4));
    if (magic[0] !== 0x50 || magic[1] !== 0x4B) {
      return jsonResponse({ error: 'Not a zip file' }, 400);
    }

    const zip = await JSZip.loadAsync(buffer);
    const allFiles = Object.keys(zip.files).filter(f => !zip.files[f].dir);

    const candidates = ['README.md', 'readme.md', 'README.txt', 'readme.txt', 'README', 'readme'];
    let readmeContent = null;
    let readmeName = null;

    for (const candidate of candidates) {
      if (allFiles.includes(candidate)) {
        readmeName = candidate;
        readmeContent = await zip.files[candidate].async('string');
        break;
      }
      const found = allFiles.find(f => f.endsWith('/' + candidate));
      if (found) {
        readmeName = found;
        readmeContent = await zip.files[found].async('string');
        break;
      }
    }

    if (!readmeContent) {
      const mdFile = allFiles.find(f => f.toLowerCase().endsWith('.md') && !f.includes('node_modules'));
      if (mdFile) {
        readmeName = mdFile;
        readmeContent = await zip.files[mdFile].async('string');
      }
    }

    if (!readmeContent) {
      return jsonResponse({ error: 'No README found' }, 404);
    }

    const isMd = readmeName && (readmeName.endsWith('.md') || readmeName.endsWith('.markdown'));
    return jsonResponse({
      type: 'readme',
      content: readmeContent,
      isMarkdown: !!isMd,
      name: readmeName,
    });

  } catch (err) {
    console.error('README error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

// ── Helper functions (unchanged from previous) ──
function findEntryHTML(files) {
  const priorities = ['index.html', 'main.html', 'home.html', 'index.htm', 'main.htm'];
  for (const name of priorities) {
    if (files.includes(name)) return name;
  }
  for (const name of priorities) {
    const found = files.find(f => f.endsWith('/' + name));
    if (found) return found;
  }
  return files.find(f => f.endsWith('.html') || f.endsWith('.htm')) || null;
}

function getMime(ext) {
  const map = {
    html: 'text/html', htm: 'text/html', css: 'text/css',
    js: 'application/javascript', mjs: 'application/javascript',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    otf: 'font/otf', ico: 'image/x-icon', json: 'application/json',
    xml: 'application/xml', pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

function resolvePath(path, baseDir) {
  if (!path) return path;
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) return path;
  if (path.startsWith('/')) return path.slice(1);
  let resolved = path;
  if (resolved.startsWith('./')) resolved = resolved.slice(2);
  const parts = (baseDir + resolved).split('/');
  const result = [];
  for (const part of parts) {
    if (part === '..') result.pop();
    else if (part !== '.' && part !== '') result.push(part);
  }
  return result.join('/');
}

function rewriteHTML(html, baseDir, blobMap, entryPath) {
  const entryDir = entryPath.includes('/') ? entryPath.split('/').slice(0, -1).join('/') + '/' : '';
  const basenameMap = {};
  for (const [key, url] of Object.entries(blobMap)) {
    const base = key.split('/').pop();
    if (base) basenameMap[base] = url;
  }

  function getBlobUrl(rawPath) {
    if (!rawPath) return null;
    if (rawPath.startsWith('data:') || rawPath.startsWith('http://') || rawPath.startsWith('https://')) return rawPath;
    const clean = rawPath.split('?')[0].split('#')[0];
    let resolved = resolvePath(clean, entryDir);
    if (blobMap[resolved]) return blobMap[resolved];
    if (resolved.startsWith('/')) {
      const alt = resolved.slice(1);
      if (blobMap[alt]) return blobMap[alt];
    }
    const base = clean.split('/').pop();
    if (base && basenameMap[base]) return basenameMap[base];
    if (blobMap[clean]) return blobMap[clean];
    return null;
  }

  let result = html.replace(/(src|href|srcset)\s*=\s*["']([^"']*)["']/gi, (match, attr, value) => {
    if (attr === 'srcset') {
      const parts = value.split(',').map(p => p.trim());
      const rewritten = parts.map(part => {
        const [urlPart, size] = part.split(/\s+/);
        const blobUrl = getBlobUrl(urlPart);
        if (blobUrl) return size ? `${blobUrl} ${size}` : blobUrl;
        return part;
      }).join(', ');
      return `${attr}="${rewritten}"`;
    }
    const blobUrl = getBlobUrl(value);
    if (blobUrl) return `${attr}="${blobUrl}"`;
    return match;
  });

  result = result.replace(/style\s*=\s*["']([^"']*)["']/gi, (match, styleContent) => {
    const rewritten = styleContent.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, urlPath) => {
      const blobUrl = getBlobUrl(urlPath);
      if (blobUrl) return `url("${blobUrl}")`;
      return m;
    });
    return `style="${rewritten}"`;
  });

  result = result.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, content) => {
    const rewritten = content.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, urlPath) => {
      const blobUrl = getBlobUrl(urlPath);
      if (blobUrl) return `url("${blobUrl}")`;
      return m;
    });
    return `<style${attrs}>${rewritten}</style>`;
  });

  result = result.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, content) => {
    const rewritten = content.replace(/@import\s+["']([^"']+)["']/gi, (m, urlPath) => {
      const blobUrl = getBlobUrl(urlPath);
      if (blobUrl) return `@import "${blobUrl}"`;
      return m;
    });
    return `<style${attrs}>${rewritten}</style>`;
  });

  return result;
}

function rewriteCSS(css, baseDir, blobMap) {
  const basenameMap = {};
  for (const [key, url] of Object.entries(blobMap)) {
    const base = key.split('/').pop();
    if (base) basenameMap[base] = url;
  }

  function getBlobUrl(rawPath) {
    if (!rawPath) return null;
    if (rawPath.startsWith('data:') || rawPath.startsWith('http://') || rawPath.startsWith('https://')) return rawPath;
    const clean = rawPath.split('?')[0].split('#')[0];
    let resolved = resolvePath(clean, baseDir);
    if (blobMap[resolved]) return blobMap[resolved];
    if (resolved.startsWith('/')) {
      const alt = resolved.slice(1);
      if (blobMap[alt]) return blobMap[alt];
    }
    const base = clean.split('/').pop();
    if (base && basenameMap[base]) return basenameMap[base];
    if (blobMap[clean]) return blobMap[clean];
    return null;
  }

  let result = css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, urlPath) => {
    const blobUrl = getBlobUrl(urlPath);
    if (blobUrl) return `url("${blobUrl}")`;
    return m;
  });
  result = result.replace(/@import\s+["']([^"']+)["']/gi, (m, urlPath) => {
    const blobUrl = getBlobUrl(urlPath);
    if (blobUrl) return `@import "${blobUrl}"`;
    return m;
  });
  return result;
}

return new Response(rewrittenHtml, {
  status: 200,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    ...corsHeaders,
  },
});
