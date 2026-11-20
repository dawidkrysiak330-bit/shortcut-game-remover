-- =============================================================
-- E1: Baza + auth + multi-tenant (RLS)
-- Każdy wiersz z danymi klienta ma org_id; dostęp tylko dla członków organizacji.
-- Tabele "robocze" (raw_records, suppression_list) — tylko service role (Edge Functions).
-- =============================================================

create extension if not exists pgcrypto;

-- ---------- Plany i organizacje ----------
create table public.plans (
  id text primary key,
  name text not null,
  max_searches_per_month int not null,
  max_cost_per_search_usd numeric(10,4) not null,  -- twardy limit kosztu jednego wyszukiwania
  max_results_per_search int not null
);
insert into public.plans values
  ('trial',   'Trial',    10, 2.00,  60),
  ('starter', 'Starter',  50, 5.00, 150),
  ('pro',     'Pro',     300, 10.00, 300);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan_id text not null default 'trial' references public.plans(id),
  retention_days int not null default 90 check (retention_days between 1 and 365), -- RODO: retencja leadów
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  primary key (org_id, user_id)
);

-- Funkcje pomocnicze dla RLS (security definer, żeby uniknąć rekurencji polityk)
create or replace function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where org_id = p_org and user_id = auth.uid());
$$;
create or replace function public.is_owner(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where org_id = p_org and user_id = auth.uid() and role = 'owner');
$$;

-- Nowy użytkownik → własna organizacja (rola owner)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  insert into public.organizations(name) values (coalesce(new.email, 'Organizacja')) returning id into v_org;
  insert into public.memberships(org_id, user_id, role) values (v_org, new.id, 'owner');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Konfiguracja: wagi scoringu i cennik źródeł ----------
create table public.scoring_weights (
  id uuid primary key default gen_random_uuid(),
  org_id uuid unique references public.organizations(id) on delete cascade, -- NULL = domyślne globalne
  industry int not null default 30,
  buying_signals int not null default 25,
  scale int not null default 15,
  location int not null default 10,
  activity int not null default 10,
  contact int not null default 10,
  unknown_scale_factor numeric(3,2) not null default 0.5 check (unknown_scale_factor between 0 and 1),
  updated_at timestamptz not null default now(),
  constraint weights_sum_100 check (industry + buying_signals + scale + location + activity + contact = 100)
);
insert into public.scoring_weights(org_id) values (null);

-- Cennik: ceny NIEZWERYFIKOWANE mają verified=false i 0 — uzupełnij z oficjalnych cenników (SOURCES.md)
create table public.source_pricing (
  source text not null,
  sku text not null,
  unit text not null,             -- 'request' | 'mtok_in' | 'mtok_out'
  unit_cost_usd numeric(12,6) not null default 0,
  verified boolean not null default false,
  note text,
  primary key (source, sku, unit)
);
insert into public.source_pricing values
  ('google_places','text_search_enterprise','request',0,false,'Sprawdź: https://developers.google.com/maps/billing-and-pricing/pricing (SKU zależy od field mask)'),
  ('google_places','place_details_enterprise','request',0,false,'Sprawdź cennik Places API (New) — Place Details'),
  ('google_places','text_search_location_only','request',0,false,'Geokodowanie miasta (field mask: places.location) — sprawdź SKU'),
  ('anthropic','claude-opus-5-5','mtok_in',4.00,true,'Cennik Anthropic (stan 2026-11) — zweryfikuj na https://www.anthropic.com/pricing'),
  ('anthropic','claude-opus-5-5','mtok_out',20.00,true,'j.w.'),
  ('gus_bir','report','request',0,true,'Usługa bezpłatna (wymaga klucza)'),
  ('krs','odpis','request',0,true,'API KRS bezpłatne'),
  ('biala_lista','search','request',0,true,'API bezpłatne, limity dzienne — patrz SOURCES.md'),
  ('ceidg','firma','request',0,true,'API bezpłatne (wymaga tokenu)'),
  ('vies','check','request',0,true,'Bezpłatne'),
  ('website','page','request',0,true,'Własny crawler');

-- ---------- ICP i wyszukiwania ----------
create table public.icps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users(id),
  product_phrase text not null,
  icp jsonb not null,
  created_at timestamptz not null default now()
);

create table public.searches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users(id),
  icp jsonb not null,                      -- migawka ICP użyta do wyszukiwania
  country text not null default 'PL',
  region_code text not null,               -- TERYT województwa (PL)
  city text,                               -- opcjonalnie: środek promienia
  radius_km int check (radius_km between 1 and 300),
  status text not null default 'queued'
    check (status in ('queued','discovering','enriching','scoring','done','cancelled','failed')),
  progress int not null default 0 check (progress between 0 and 100),
  message text,
  cancel_requested boolean not null default false,
  job_state jsonb not null default '{}'::jsonb,   -- stan kolejki (który krok, co przetworzono)
  lock_until timestamptz,                         -- blokada, żeby dwa "ticki" nie pracowały naraz
  cost_usd numeric(12,6) not null default 0,
  results_count int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on public.searches(org_id, created_at desc);

-- Surowe rekordy ze źródeł — dane robocze, usuwane po zakończeniu wyszukiwania.
create table public.raw_records (
  id bigserial primary key,
  search_id uuid not null references public.searches(id) on delete cascade,
  source text not null,
  payload jsonb not null,           -- RawCompany
  created_at timestamptz not null default now()
);
create index on public.raw_records(search_id);

-- Leady (wynik). Treści z Google Places trzymamy OSOBNO (places_data) z datą wygaśnięcia.
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  search_id uuid not null references public.searches(id) on delete cascade,
  dedup_key text not null,
  place_id text,                     -- Google: place_id wolno przechowywać trwale
  nip text,
  data jsonb not null,               -- pola z rejestrów i www: {field: FieldValue[]}
  places_data jsonb,                 -- pola z Google Places: czyszczone po places_expires_at
  places_expires_at timestamptz,
  website_pages jsonb not null default '[]'::jsonb,
  score jsonb not null,              -- ScoreResult (składowe + uzasadnienie)
  score_total int not null,
  confidence text not null,
  excluded boolean not null default false,
  is_natural_person boolean not null default false,  -- JDG = dane osobowe (RODO)
  card jsonb,                        -- wygenerowana karta (LLM, zwalidowana)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,   -- retencja (organizations.retention_days)
  unique (search_id, dedup_key)
);
create index on public.leads(search_id, score_total desc);
create index on public.leads(nip);

-- ---------- Koszty, logi LLM, RODO ----------
create table public.api_usage (
  id bigserial primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  search_id uuid references public.searches(id) on delete set null,
  source text not null,
  sku text not null,
  units numeric(14,4) not null,
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);
create index on public.api_usage(org_id, created_at);

create table public.llm_rejections (
  id bigserial primary key,
  org_id uuid references public.organizations(id) on delete cascade,
  kind text not null,              -- 'icp' | 'lead_card'
  ref_id uuid,
  raw_output text,
  errors jsonb not null,
  created_at timestamptz not null default now()
);

-- Lista "nie zbieraj" (żądania usunięcia/sprzeciwu, RODO art. 17/21). Hash NIP lub domena.
create table public.suppression_list (
  id bigserial primary key,
  org_id uuid references public.organizations(id) on delete cascade, -- NULL = globalnie (ustawia tylko operator SaaS)
  nip_hash text,
  domain text,
  reason text not null,
  created_at timestamptz not null default now()
);

create unique index on public.suppression_list(coalesce(org_id::text,'*'), nip_hash) where nip_hash is not null;
create unique index on public.suppression_list(coalesce(org_id::text,'*'), domain) where domain is not null;

create table public.erasure_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  requested_by uuid not null default auth.uid() references auth.users(id),
  nip text,
  domain text,
  note text,
  status text not null default 'done',
  created_at timestamptz not null default now()
);

-- ---------- RLS ----------
alter table public.plans enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.scoring_weights enable row level security;
alter table public.source_pricing enable row level security;
alter table public.icps enable row level security;
alter table public.searches enable row level security;
alter table public.raw_records enable row level security;      -- brak polityk = tylko service role
alter table public.leads enable row level security;
alter table public.api_usage enable row level security;
alter table public.llm_rejections enable row level security;   -- brak polityk = tylko service role
alter table public.suppression_list enable row level security; -- brak polityk = tylko service role
alter table public.erasure_requests enable row level security;

create policy "plans readable" on public.plans for select to authenticated using (true);
create policy "pricing readable" on public.source_pricing for select to authenticated using (true);

create policy "org members read" on public.organizations for select to authenticated using (public.is_member(id));
create policy "org owner update" on public.organizations for update to authenticated
  using (public.is_owner(id)) with check (public.is_owner(id));
-- plan_id zmienia tylko service role (płatności) — owner może zmienić nazwę i retencję
revoke update on public.organizations from authenticated;
grant update (name, retention_days) on public.organizations to authenticated;

create policy "own memberships" on public.memberships for select to authenticated using (public.is_member(org_id));

create policy "weights read" on public.scoring_weights for select to authenticated
  using (org_id is null or public.is_member(org_id));
create policy "weights owner insert" on public.scoring_weights for insert to authenticated with check (public.is_owner(org_id));
create policy "weights owner update" on public.scoring_weights for update to authenticated
  using (public.is_owner(org_id)) with check (public.is_owner(org_id));

create policy "icps member all" on public.icps for all to authenticated
  using (public.is_member(org_id)) with check (public.is_member(org_id));

create policy "searches member read" on public.searches for select to authenticated using (public.is_member(org_id));
create policy "searches member insert" on public.searches for insert to authenticated
  with check (public.is_member(org_id) and status = 'queued');
-- użytkownik podaje tylko parametry wyszukiwania; status/koszt ustawia backend
revoke insert on public.searches from authenticated;
grant insert (org_id, icp, country, region_code, city, radius_km) on public.searches to authenticated;
-- Użytkownik może jedynie poprosić o przerwanie (cancel_requested); resztę zmienia Edge Function.
revoke update on public.searches from authenticated;
grant update (cancel_requested) on public.searches to authenticated;
create policy "searches member cancel" on public.searches for update to authenticated
  using (public.is_member(org_id)) with check (public.is_member(org_id));

create policy "leads member read" on public.leads for select to authenticated using (public.is_member(org_id));
create policy "leads member delete" on public.leads for delete to authenticated using (public.is_member(org_id));

create policy "usage member read" on public.api_usage for select to authenticated using (public.is_member(org_id));

create policy "erasure member read" on public.erasure_requests for select to authenticated using (public.is_member(org_id));

-- ---------- Widok: zużycie w bieżącym miesiącu (dla panelu i limitów) ----------
create view public.org_usage_month with (security_invoker = true) as
select o.id as org_id, o.plan_id,
  (select count(*) from public.searches s where s.org_id = o.id and s.created_at >= date_trunc('month', now())) as searches_this_month,
  (select coalesce(sum(cost_usd),0) from public.api_usage u where u.org_id = o.id and u.created_at >= date_trunc('month', now())) as cost_this_month_usd
from public.organizations o;

-- ---------- RODO: usunięcie danych podmiotu na żądanie ----------
-- Wariant dla klienta (organizacji): usuwa leady z danym NIP/domeną w JEGO organizacji
-- i dodaje wpis do jego suppression_list (nie będą ponownie zbierane dla tej organizacji).
-- Żądanie skierowane do operatora SaaS (wszystkie organizacje): admin wywołuje erase_subject_global
-- z SQL Editora (service role) — patrz COMPLIANCE.md.
create or replace function public.erase_subject(p_org uuid, p_nip text, p_domain text, p_note text)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare v_count int; v_nip text := nullif(regexp_replace(coalesce(p_nip,''), '\D', '', 'g'), '');
begin
  if not public.is_member(p_org) then raise exception 'Brak dostępu do organizacji'; end if;
  delete from public.leads l
   where l.org_id = p_org
     and ((v_nip is not null and l.nip = v_nip)
       or (p_domain is not null and l.data::text ilike '%' || lower(p_domain) || '%'));
  get diagnostics v_count = row_count;
  if v_nip is not null then
    insert into public.suppression_list(org_id, nip_hash, reason)
    values (p_org, encode(digest(v_nip, 'sha256'), 'hex'), coalesce(p_note, 'erasure')) on conflict do nothing;
  end if;
  if p_domain is not null then
    insert into public.suppression_list(org_id, domain, reason) values (p_org, lower(p_domain), coalesce(p_note, 'erasure'))
    on conflict do nothing;
  end if;
  insert into public.erasure_requests(org_id, nip, domain, note) values (p_org, v_nip, p_domain, p_note);
  return v_count;
end $$;
revoke all on function public.erase_subject(uuid, text, text, text) from public;
grant execute on function public.erase_subject(uuid, text, text, text) to authenticated;

-- Wariant globalny — TYLKO operator (service role / SQL Editor).
create or replace function public.erase_subject_global(p_nip text, p_domain text, p_note text)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare v_count int; v_nip text := nullif(regexp_replace(coalesce(p_nip,''), '\D', '', 'g'), '');
begin
  delete from public.leads l
   where (v_nip is not null and l.nip = v_nip)
      or (p_domain is not null and l.data::text ilike '%' || lower(p_domain) || '%');
  get diagnostics v_count = row_count;
  if v_nip is not null then
    insert into public.suppression_list(nip_hash, reason) values (encode(digest(v_nip, 'sha256'), 'hex'), coalesce(p_note, 'erasure'))
    on conflict do nothing;
  end if;
  if p_domain is not null then
    insert into public.suppression_list(domain, reason) values (lower(p_domain), coalesce(p_note, 'erasure')) on conflict do nothing;
  end if;
  return v_count;
end $$;
revoke all on function public.erase_subject_global(text, text, text) from public, authenticated, anon;

-- ---------- Sprzątanie: wygasłe treści Google Places i retencja leadów ----------
create or replace function public.purge_expired() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.leads set places_data = null, places_expires_at = null
   where places_expires_at is not null and places_expires_at < now();
  delete from public.leads where expires_at < now();
  delete from public.raw_records r using public.searches s
   where r.search_id = s.id and (s.status in ('done','cancelled','failed') or s.created_at < now() - interval '1 day');
end $$;
revoke all on function public.purge_expired() from public, authenticated;
