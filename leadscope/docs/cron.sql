-- Uruchom raz w Supabase → SQL Editor. Wymaga rozszerzenia pg_cron (Database → Extensions).
create extension if not exists pg_cron;
-- co godzinę (minuta 17): czyści wygasłe treści Google Places, leady po okresie retencji i dane robocze
select cron.schedule('leadscope-purge', '17 * * * *', $$select public.purge_expired()$$);
