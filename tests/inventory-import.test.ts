import { describe, expect, it } from 'vitest';
// Operator script is JavaScript and deliberately has no application dependency.
// @ts-expect-error no declaration file is needed for the operator CLI
import { prepareImport } from '../scripts/prepare-inventory-import.mjs';

function source() {
  return {
    Staff: [['staffID','first','last'],['SYN-ST-1','Ada',"O'Example"]],
    Students: [['studentID','fullName'],['SYN-OS-1','Synthetic Student']],
    DeviceSheet: [['Type','Manufacturer','Model'],['Laptop','Example','Book']],
    Master_Inventory: [Array(14).fill('header'),
      ['SYN-DEV-1','Laptop','Example','Book','Test OS','SYN-SERIAL','', 'Available','','Lab','SYN-OS-1','','','']],
  };
}

describe('initial inventory import preparation', () => {
  it('keeps stable directory keys and explicit assignments, with safe SQL quoting and a rerun guard', () => {
    const { report, script } = prepareImport(source());
    expect(report).toMatchObject({staff:1,students:1,inventory:1,catalog:1});
    expect(script).toContain("Ada O''Example");
    expect(script).toContain("'student','SYN-OS-1'");
    expect(script).toContain('Directory already imported');
    expect(script.startsWith('begin;')).toBe(true);
    expect(script.endsWith('commit;\n')).toBe(true);
  });
  it('quarantines every row with a conflicting device ID instead of choosing a winner', () => {
    const data = source();
    data.Master_Inventory.push([...data.Master_Inventory[1]]);
    const {report,script} = prepareImport(data);
    expect(report.duplicateDeviceRows).toEqual([2,3]);
    expect(report.inventory).toBe(0);
    expect(script).not.toContain('SYN-DEV-1');
  });
  it('leaves an unresolved assignment unlinked and flags incomplete devices', () => {
    const data = source();
    data.Master_Inventory[1][10] = 'SYN-NOT-IN-DIRECTORY';
    data.Master_Inventory[1][5] = '';
    const {report,script} = prepareImport(data);
    expect(report.unresolvedAssignments).toEqual([2]);
    expect(report.incompleteDevices).toEqual([2]);
    expect(script).not.toContain('SYN-NOT-IN-DIRECTORY');
  });
  it('refuses duplicate people rather than silently merging distinct identities', () => {
    const data = source();
    data.Students.push(['SYN-OS-1','Different Synthetic Student']);
    expect(() => prepareImport(data)).toThrow(/duplicate Students identity/);
  });
});
