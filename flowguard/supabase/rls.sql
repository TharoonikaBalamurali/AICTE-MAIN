-- AICTE FlowGuard — Supabase row-level security (defence in depth). NOT YET TESTED against a live Supabase project.
--
-- Design: browsers never talk to the database directly. Every read/write goes through the FlowGuard API,
-- which enforces authentication, role, institution membership, record ownership and workflow state.
-- The API connects with a server-side role (DATABASE_URL) that is not exposed to clients.
-- Therefore RLS is enabled on every table with NO policies for the `anon` and `authenticated` roles,
-- which denies all direct access through Supabase's PostgREST / client SDK with the public anon key.
--
-- Apply AFTER all server/db/migrations/*.sql (re-run after each new migration), in the Supabase SQL editor.

DO $$
DECLARE t text;
BEGIN
  -- Every FlowGuard table (all migrations, incl. 002-004: EVC registry, escalations, deadlines, compliance history).
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
  -- Views run with the owner's rights; deny direct access to them as well.
  FOR t IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- The API's database role must bypass RLS (Supabase's `postgres` / service role does), or be granted explicit policies.
-- Documents must be stored in a PRIVATE Storage bucket (no public URLs); downloads are streamed by the API after authorisation.
