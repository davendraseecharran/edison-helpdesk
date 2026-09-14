import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { resolveLocalStack } from './support/local-only';
// @ts-expect-error operator CLI is intentionally plain JavaScript
import { prepareImport } from '../../scripts/prepare-inventory-import.mjs';

it('executes the prepared import with stable person links and escaped names in an isolated transaction', () => {
  resolveLocalStack();
  const schema = `import_review_${randomUUID().replaceAll('-', '')}`;
  const source = {
    Staff: [['id','first','last'], ['STAFF-SYNTH','Ada', "O'Example"]],
    Students: [['id','name'], ['OSIS-SYNTH','Synthetic Student']],
    DeviceSheet: [['type','manufacturer','model'], ['Laptop','Example','Book']],
    Master_Inventory: [Array(14).fill('header'),
      ['DEVICE-SYNTH','Laptop','Example','Book','','SERIAL-SYNTH','','Assigned','','Lab','OSIS-SYNTH','','','']],
  };
  const { script } = prepareImport(source);
  const setup = `create schema ${schema};
    create table ${schema}.app_accounts(id uuid default gen_random_uuid(),role text,status text,created_at timestamptz default now());
    insert into ${schema}.app_accounts(role,status) values('admin','active');
    create table ${schema}.requesters(like public.requesters including all);
    create table ${schema}.device_catalog(like public.device_catalog including all);
    create table ${schema}.inventory_devices(like public.inventory_devices including all);`;
  const checks = `select 'people='||count(*) from ${schema}.requesters;
    select 'assigned='||count(*) from ${schema}.inventory_devices d join ${schema}.requesters r on r.id=d.assigned_requester_id where r.external_id='OSIS-SYNTH';
    select 'quoted='||count(*) from ${schema}.requesters where display_name='Ada O''Example';
    rollback;`;
  const sql = script.replaceAll('public.',`${schema}.`).replace('begin;',`begin;\n${setup}`).replace('commit;',checks);
  const docker = existsSync('/Applications/Docker.app/Contents/Resources/bin/docker')
    ? '/Applications/Docker.app/Contents/Resources/bin/docker' : 'docker';
  const result = execFileSync(docker, ['exec','-i','supabase_db_edison-ticketing','psql','-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'], {
    input:sql,encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe'],
  });
  expect(result).toContain('people=2');
  expect(result).toContain('assigned=1');
  expect(result).toContain('quoted=1');
});
