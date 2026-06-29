// worker.js – Deploy to Cloudflare Workers
import { createClient } from '@supabase/supabase-js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const postId = url.searchParams.get('id');

    if (!postId) {
      return jsonResponse({ error: 'Missing product ID' }, 400);
    }

    try {
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

      // 1. Get product record
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

      // 2. Generate signed URL (60s expiry)
      const { data: signedData, error: signErr } = await supabase
        .storage
        .from('uploads')
        .createSignedUrl(post.file_path, 60);

      if (signErr || !signedData?.signedUrl) {
        return jsonResponse({ error: 'Could not generate download link' }, 500);
      }

      // 3. Return the signed URL + product info
      return jsonResponse({
        id: post.id,
        name: post.name,
        signedUrl: signedData.signedUrl,
      });

    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
