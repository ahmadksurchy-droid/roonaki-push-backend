import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('[Roonaki Push] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

export const supabase = createClient(supabaseUrl || 'http://localhost', supabaseKey || 'missing', {
  auth: { persistSession: false },
});
