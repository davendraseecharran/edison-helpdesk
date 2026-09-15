/**
 * A leaver can be archived, and Today can see it.
 *
 * `requesters.archived_at` existed from 20260914130000 and was read by
 * `app_today_devices_due` from 20260914150200, but no RPC wrote it, so half of
 * that row's "Holder has left" reason was unreachable. 20260915010000 gave the
 * directory's two doors the column: `app_person_json` reads `archivedAt` back,
 * `app_save_person` takes `archived`.
 *
 * What is proved here: the round trip, that the date does not move when an
 * already-archived record is saved again, that unticking clears it, that a save
 * which does not mention the key leaves it alone — which is what keeps every
 * older caller working — that a non-boolean is refused rather than read as
 * false, and that a machine held by an archived member of staff now reaches
 * Today's devices-due list, which is the reason the column exists.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rpcFails, rpcOk, signIn } from './support/harness';
import type { SupabaseClient } from '@supabase/supabase-js';

interface PersonJson {
  id: string;
  version: number;
  displayName: string;
  archivedAt: string | null;
  notes: string;
}

interface DueDevice {
  id: string;
  reason: string;
  holder_name: string | null;
}

interface TodayDevices {
  rows: DueDevice[];
}

let tech: SupabaseClient;
let staffId: string;

const suffix = randomUUID().slice(0, 8);
const staffData = {
  kind: 'staff',
  displayName: 'Synthetic Departing Staff',
  email: `departing.${suffix}@edison.example`,
  department: 'Science',
  notes: 'Synthetic record for the archive test.',
};

async function read(id: string): Promise<PersonJson> {
  return rpcOk<PersonJson>(tech, 'app_get_person', { p_id: id });
}

beforeAll(async () => {
  tech = await signIn('owner');
  staffId = await rpcOk<string>(tech, 'app_save_person', {
    p_id: null,
    p_version: null,
    p_data: staffData,
  });
});

describe('archiving somebody who has left', () => {
  it('reads back as null while they are still here', async () => {
    const person = await read(staffId);
    expect(person.archivedAt).toBeNull();
  });

  it('stamps the time when the box is ticked, and keeps it when it is ticked again', async () => {
    let person = await read(staffId);
    await rpcOk(tech, 'app_save_person', {
      p_id: staffId,
      p_version: person.version,
      p_data: { ...staffData, archived: true },
    });

    person = await read(staffId);
    expect(person.archivedAt).not.toBeNull();
    const first = person.archivedAt;

    // A later, unrelated edit that still says "archived" must not restate when
    // they left: the date is a record of one event, not of the last save.
    await rpcOk(tech, 'app_save_person', {
      p_id: staffId,
      p_version: person.version,
      p_data: { ...staffData, notes: 'Corrected a phone number.', archived: true },
    });

    person = await read(staffId);
    expect(person.archivedAt).toBe(first);
    expect(person.notes).toBe('Corrected a phone number.');
  });

  it('leaves the date alone when a save does not mention it', async () => {
    const before = await read(staffId);
    expect(before.archivedAt).not.toBeNull();

    await rpcOk(tech, 'app_save_person', {
      p_id: staffId,
      p_version: before.version,
      p_data: { ...staffData, notes: 'A save from a caller that predates the column.' },
    });

    const after = await read(staffId);
    expect(after.archivedAt).toBe(before.archivedAt);
  });

  it('raises the machine they are still holding on Today, as "holder left"', async () => {
    const deviceId = await rpcOk<string>(tech, 'app_save_inventory_device', {
      p_id: null,
      p_version: null,
      p_data: {
        deviceType: 'Laptop',
        manufacturer: 'Example',
        model: 'Archive Test',
        serialNumber: `SYN-ARCH-${suffix}`,
        status: 'Assigned',
        assignedRequesterId: staffId,
      },
    });

    const due = await rpcOk<TodayDevices>(tech, 'app_today_devices_due', {});
    const row = due.rows.find((entry) => entry.id === deviceId);
    expect(row).toBeDefined();
    expect(row?.reason).toBe('holder_left');
  });

  it('clears the date when the box is unticked, because somebody back is not somebody else', async () => {
    const person = await read(staffId);
    await rpcOk(tech, 'app_save_person', {
      p_id: staffId,
      p_version: person.version,
      p_data: { ...staffData, archived: false },
    });

    expect((await read(staffId)).archivedAt).toBeNull();
  });

  it('refuses anything that is not true or false rather than reading it as false', async () => {
    const person = await read(staffId);
    for (const value of ['yes', 1, null, {}]) {
      const failure = await rpcFails(tech, 'app_save_person', {
        p_id: staffId,
        p_version: person.version,
        p_data: { ...staffData, archived: value },
      });
      expect(failure.message).toMatch(/true or false/);
    }
    expect((await read(staffId)).archivedAt).toBeNull();
  });
});
