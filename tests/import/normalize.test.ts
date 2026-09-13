import { describe, expect, it } from 'vitest';
import {
  PEOPLE_FIELDS,
  PRESETS,
  mapStatus,
  normaliseOsis,
  parseCsv,
  splitDeviceId,
  toDeviceRows,
  toPersonRows,
} from '../../src/lib/import/index';
import type { ColumnPreset } from '../../src/lib/import/index';

const students = PRESETS.find((preset) => preset.id === 'appsheet_students')!;
const staff = PRESETS.find((preset) => preset.id === 'appsheet_staff')!;
const inventory = PRESETS.find((preset) => preset.id === 'appsheet_inventory')!;

const STUDENT_HEADER =
  'Student ID:,Name,studentEmail,Parent,parentNumber,homeNumber,Class of,officalClass,studentAddress,Notes';
const STAFF_HEADER = 'firstName,lastName,staffEmail,schoolDBN,Department:,Role:';
const INVENTORY_HEADER =
  'DeviceID,SerialNumber,Type,Manufacturer,Model,OS,AssetTag,Status,Assigned To,Location,OSIS,Student Name,StaffID,Staff Name,Notes';

function people(body: string, preset: ColumnPreset = students) {
  return toPersonRows(parseCsv(`${body}\n`), preset);
}
function devices(body: string, preset: ColumnPreset = inventory) {
  return toDeviceRows(parseCsv(`${body}\n`), preset);
}

describe('normaliseOsis', () => {
  it('strips the spreadsheet separators the school exports', () => {
    expect(normaliseOsis('243,025,319')).toBe('243025319');
    expect(normaliseOsis(' 240 000 123 ')).toBe('240000123');
    expect(normaliseOsis('240000123')).toBe('240000123');
  });

  it('rejects anything that is not 6 to 12 digits', () => {
    expect(normaliseOsis('')).toBeNull();
    expect(normaliseOsis('   ')).toBeNull();
    expect(normaliseOsis('12345')).toBeNull();
    expect(normaliseOsis('1234567890123')).toBeNull();
    expect(normaliseOsis('24A0000123')).toBeNull();
    expect(normaliseOsis('n/a')).toBeNull();
  });
});

describe('splitDeviceId', () => {
  it('splits an AppSheet device id into serial and os', () => {
    expect(splitDeviceId('PW0FYJ9B-WIN')).toEqual({ serial: 'PW0FYJ9B', os: 'WIN' });
    expect(splitDeviceId(' pw0fyj9b-win ')).toEqual({ serial: 'PW0FYJ9B', os: 'WIN' });
  });

  it('splits on the last hyphen so a hyphenated serial survives', () => {
    expect(splitDeviceId('DOE-LN0000001-CHROME')).toEqual({
      serial: 'DOE-LN0000001',
      os: 'CHROME',
    });
  });

  it('treats an id without a suffix as the serial on its own', () => {
    expect(splitDeviceId('PW0FYJ9B')).toEqual({ serial: 'PW0FYJ9B', os: null });
    expect(splitDeviceId('PW0FYJ9B-')).toEqual({ serial: 'PW0FYJ9B', os: null });
    expect(splitDeviceId('')).toEqual({ serial: null, os: null });
  });
});

describe('mapStatus', () => {
  it('maps the spreadsheet words onto the device statuses', () => {
    expect(mapStatus('Deployed')).toBe('deployed');
    expect(mapStatus('In Stock')).toBe('in_stock');
    expect(mapStatus('Available')).toBe('in_stock');
    expect(mapStatus('')).toBe('in_stock');
    expect(mapStatus('Repair')).toBe('in_repair');
    expect(mapStatus(' in repair ')).toBe('in_repair');
    expect(mapStatus('in_repair')).toBe('in_repair');
    expect(mapStatus('in-repair')).toBe('in_repair');
    expect(mapStatus('Retired')).toBe('retired');
    expect(mapStatus('Lost')).toBe('lost');
    expect(mapStatus('Missing')).toBe('lost');
    expect(mapStatus('Surplus')).toBe('surplus');
  });

  it('falls back to in stock for a word it does not know', () => {
    expect(mapStatus('On a cart somewhere')).toBe('in_stock');
  });
});

describe('toPersonRows: students', () => {
  it('normalises a student row into directory columns', () => {
    const { rows, errors } = people(
      `${STUDENT_HEADER}\n"243,025,319",Pat Example, Pat.Example@STUDENT.edison.example ,Jamie Example,(212) 555-0143,+1 212-555-0198,2028,9A,"12 Example Ave,  Apt 4",`,
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        kind: 'student',
        first_name: 'Pat',
        last_name: 'Example',
        display_name: 'Pat Example',
        email: 'pat.example@student.edison.example',
        osis: '243025319',
        staff_id: null,
        school_dbn: null,
        department: null,
        role_title: null,
        official_class: '9A',
        class_of: '2028',
        parent_name: 'Jamie Example',
        parent_phone: '2125550143',
        home_phone: '+12125550198',
        address: '12 Example Ave, Apt 4',
        notes: null,
      },
    ]);
  });

  it('emits exactly the columns the people upsert accepts', () => {
    const { rows } = people(`${STUDENT_HEADER}\n240000123,Pat Example,,,,,,,,`);
    expect(Object.keys(rows[0]).sort()).toEqual([...PEOPLE_FIELDS].sort());
    expect(rows[0]).not.toHaveProperty('active');
  });

  it('splits a name on the last space and keeps the full name for display', () => {
    const { rows } = people(
      `${STUDENT_HEADER}\n240000123,Pat Q Example,,,,,,,,\n240000124,  Prince  ,,,,,,,,\n240000125,"Example,  Pat",,,,,,,,`,
    );
    expect(rows.map((row) => [row.first_name, row.last_name, row.display_name])).toEqual([
      ['Pat Q', 'Example', 'Pat Q Example'],
      ['', 'Prince', 'Prince'],
      ['Example,', 'Pat', 'Example, Pat'],
    ]);
  });

  it('reports a bad OSIS against its own data row and imports the rest', () => {
    const { rows, errors } = people(
      `${STUDENT_HEADER}\n240000123,Pat Example,,,,,,,,\n24A0000123,River Sample,,,,,,,,\n240000125,Sam Sample,,,,,,,,`,
    );
    expect(rows.map((row) => row.display_name)).toEqual(['Pat Example', 'Sam Sample']);
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(2);
    expect(errors[0].message).toContain('6 to 12 digits');
  });

  it('reports a row with no name', () => {
    const { rows, errors } = people(`${STUDENT_HEADER}\n240000123,  ,,,,,,,,`);
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ row: 1, message: expect.stringContaining('name') }]);
  });

  it('skips a blank line without calling it an error', () => {
    const { rows, errors } = people(
      `${STUDENT_HEADER}\n240000123,Pat Example,,,,,,,,\n\n240000124,River Sample,,,,,,,,`,
    );
    expect(rows).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('reads a short row as empty trailing cells', () => {
    const { rows, errors } = people(`${STUDENT_HEADER}\n240000123,Pat Example`);
    expect(errors).toEqual([]);
    expect(rows[0].email).toBeNull();
    expect(rows[0].notes).toBeNull();
  });
});

describe('toPersonRows: staff', () => {
  it('builds the display name from both halves and folds the identifiers', () => {
    const { rows, errors } = people(
      `${STAFF_HEADER}\n Alex , Stone , Alex.Stone@EDISON.example ,12X001,Technology,Technology teacher`,
      staff,
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      kind: 'staff',
      first_name: 'Alex',
      last_name: 'Stone',
      display_name: 'Alex Stone',
      email: 'alex.stone@edison.example',
      school_dbn: '12X001',
      department: 'Technology',
      role_title: 'Technology teacher',
      osis: null,
      staff_id: null,
    });
  });

  it('accepts a staff member with only one half of a name', () => {
    const { rows, errors } = people(`${STAFF_HEADER}\n,Stone,,,,`, staff);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ first_name: '', last_name: 'Stone', display_name: 'Stone' });
  });

  it('reports a staff row with neither half of a name', () => {
    const { rows, errors } = people(`${STAFF_HEADER}\n,,alex.stone@edison.example,,,`, staff);
    expect(rows).toEqual([]);
    expect(errors[0].row).toBe(1);
  });
});

describe('toPersonRows: custom mapping', () => {
  const custom: ColumnPreset = {
    id: 'custom',
    label: 'Custom',
    kind: 'people',
    map: { kind: 'Type', display_name: 'Full name', staff_id: 'Badge', osis: 'OSIS' },
  };

  it('reads the kind from a mapped column and folds the staff id', () => {
    const { rows, errors } = people(
      'Type,Full name,Badge,OSIS\n Staff ,Alex Stone, tech-07 ,\nstudent,Pat Example,,240000123',
      custom,
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ kind: 'staff', staff_id: 'TECH-07', osis: null });
    expect(rows[1]).toMatchObject({ kind: 'student', staff_id: null, osis: '240000123' });
  });

  it('reports a row that does not say student or staff', () => {
    const { rows, errors } = people('Type,Full name,Badge,OSIS\nteacher,Alex Stone,,', custom);
    expect(rows).toEqual([]);
    expect(errors[0].message).toContain('student or staff');
  });
});

describe('toDeviceRows', () => {
  it('normalises an inventory row and derives the holder', () => {
    const { rows, errors } = devices(
      `${INVENTORY_HEADER}\npw0fyj9b-win,,Laptop,Dell,Latitude 3440,,ed-0001, Deployed ,Student,Room 214,"243,025,319",Pat Example,,,Charger missing`,
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        device_id: 'PW0FYJ9B-WIN',
        serial_number: 'PW0FYJ9B',
        asset_tag: 'ED-0001',
        type: 'Laptop',
        manufacturer: 'Dell',
        model: 'Latitude 3440',
        os: 'WIN',
        status: 'deployed',
        location: 'Room 214',
        notes: 'Charger missing',
        holder: { kind: 'student', osis: '243025319', staff_id: null, name: 'Pat Example' },
      },
    ]);
  });

  it('lets an explicit serial number and os beat the device id', () => {
    const { rows } = devices(
      `${INVENTORY_HEADER}\nPW0FYJ9B-WIN,zz9plural,Laptop,Dell,Latitude 3440,ChromeOS,,,,,,,,,`,
    );
    expect(rows[0]).toMatchObject({
      device_id: 'PW0FYJ9B-WIN',
      serial_number: 'ZZ9PLURAL',
      os: 'ChromeOS',
    });
  });

  it('takes a staff holder from the staff columns', () => {
    const { rows, errors } = devices(
      `${INVENTORY_HEADER}\n,DOE-LN0000001,Cart,Apple,MacBook Air,macOS,,In Repair,Staff,Room 3,,,tech-07,Alex Stone,`,
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      device_id: null,
      serial_number: 'DOE-LN0000001',
      status: 'in_repair',
      holder: { kind: 'staff', osis: null, staff_id: 'TECH-07', name: 'Alex Stone' },
    });
  });

  it('infers the holder kind from the identifier when the column is blank', () => {
    const { rows } = devices(
      `${INVENTORY_HEADER}\nDOE-LN0000002-WIN,,,,,,,,,,240000123,Pat Example,,,\nDOE-LN0000003-WIN,,,,,,,,,,,,tech-07,Alex Stone,`,
    );
    expect(rows[0].holder).toEqual({
      kind: 'student',
      osis: '240000123',
      staff_id: null,
      name: 'Pat Example',
    });
    expect(rows[1].holder).toEqual({
      kind: 'staff',
      osis: null,
      staff_id: 'TECH-07',
      name: 'Alex Stone',
    });
  });

  it('leaves the holder empty when there is nothing to match on', () => {
    const { rows } = devices(`${INVENTORY_HEADER}\nDOE-LN0000004-WIN,,,,,,,,Student,,,,,,`);
    expect(rows[0].holder).toBeNull();
  });

  it('defaults the type and the status', () => {
    const { rows } = devices(`${INVENTORY_HEADER}\nDOE-LN0000005-WIN,,,,,,,,,,,,,,`);
    expect(rows[0]).toMatchObject({ type: 'Laptop', status: 'in_stock', manufacturer: null });
  });

  it('reports a row with no device identifier', () => {
    const { rows, errors } = devices(
      `${INVENTORY_HEADER}\nDOE-LN0000006-WIN,,,,,,,,,,,,,,\n,,Laptop,Dell,Latitude 3440,,,In Stock,,Room 214,,,,,`,
    );
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([{ row: 2, message: expect.stringContaining('serial number') }]);
  });

  it('reports a bad holder OSIS against its own data row', () => {
    const { rows, errors } = devices(
      `${INVENTORY_HEADER}\nDOE-LN0000007-WIN,,,,,,,,Student,,24A0000123,Pat Example,,,`,
    );
    expect(rows).toEqual([]);
    expect(errors[0]).toEqual({ row: 1, message: expect.stringContaining('6 to 12 digits') });
  });

  it('skips a blank line without calling it an error', () => {
    const { rows, errors } = devices(
      `${INVENTORY_HEADER}\nDOE-LN0000008-WIN,,,,,,,,,,,,,,\n\nDOE-LN0000009-WIN,,,,,,,,,,,,,,`,
    );
    expect(rows).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});
