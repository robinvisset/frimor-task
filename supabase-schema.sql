-- À coller dans Supabase → SQL Editor → New query → Run.
-- Crée les deux tables de l'appli et ouvre des accès simples
-- adaptés à un petit outil interne (pas de compte utilisateur).

create table if not exists tasks (
  id text primary key default gen_random_uuid()::text,
  title text not null,
  time text not null,                 -- "HH:MM"
  recurrence_type text not null default 'daily',  -- 'daily' | 'days'
  recurrence_days int[] default '{}', -- 0=dimanche .. 6=samedi, utilisé si recurrence_type='days'
  example boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists logs (
  id text primary key,                -- "YYYY-MM-DD_<task_id>"
  task_id text not null references tasks(id) on delete cascade,
  date text not null,                 -- "YYYY-MM-DD"
  done boolean not null default true,
  done_at timestamptz not null default now()
);

-- Évite d'envoyer deux fois la même notification programmée.
create table if not exists scheduled_notifications (
  id text primary key,                -- "YYYY-MM-DD_<task_id>"
  task_id text not null,
  date text not null,
  created_at timestamptz not null default now()
);

alter table tasks enable row level security;
alter table logs enable row level security;
alter table scheduled_notifications enable row level security;

-- Outil interne à une seule équipe : lecture/écriture ouverte à qui a la clé "anon".
-- (La clé anon n'est jamais secrète pour ce type d'usage : elle est faite pour être
-- utilisée côté navigateur. On accepte ce compromis pour la simplicité.)
create policy "lecture publique tasks" on tasks for select using (true);
create policy "ecriture publique tasks" on tasks for insert with check (true);
create policy "modif publique tasks" on tasks for update using (true);
create policy "suppression publique tasks" on tasks for delete using (true);

create policy "lecture publique logs" on logs for select using (true);
create policy "ecriture publique logs" on logs for insert with check (true);
create policy "modif publique logs" on logs for update using (true);
create policy "suppression publique logs" on logs for delete using (true);

create policy "lecture publique scheduled" on scheduled_notifications for select using (true);
create policy "ecriture publique scheduled" on scheduled_notifications for insert with check (true);

-- Active le "Realtime" pour que l'appli se mette à jour en direct sur tous les téléphones.
alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table logs;
