import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase env vars. Check .env.local has VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.'
  )
}

// This is the public, read-only key — safe to ship in frontend code.
// Row Level Security on the ward_boundaries / ward_prices tables means
// this key can only ever SELECT, never write.
export const supabase = createClient(supabaseUrl, supabaseKey)
