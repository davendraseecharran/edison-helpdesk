'use client';

/**
 * Find one machine in 4,278 without leaving the form: the same shape as
 * `PersonPicker`, over the inventory. Each result shows the machine's label in
 * mono, what it is, and who is holding it, so a technician does not link the
 * wrong one of two identical Chromebooks. The status is the district's own
 * word for it, which is already the text it renders as.
 */

import { searchDevicesAction, type DeviceSearchResult } from '@/lib/data/device-actions';
import { SearchPicker } from '@/components/directory/SearchPicker';
import { ScanTargetButton } from '@/components/scan/ScanTargetButton';

export type { DeviceSearchResult };

export interface DevicePickerProps {
  id: string;
  label?: string;
  hint?: string;
  placeholder?: string;
  onSelect: (device: DeviceSearchResult) => void;
  excludeIds?: string[];
  excludeNote?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  error?: string | null;
  /**
   * Offer the phone as a scanner on the end of the search field.
   *
   * Off by default: this picker is used inside dialogs and forms that are
   * already modal, and a second modal surface over one of those is a worse
   * experience than typing six characters. Turned on where a technician is
   * standing next to the machine — linking a device to a ticket.
   */
  scan?: boolean;
}

export function DevicePicker({
  id,
  label = 'Find a device',
  hint = 'Search by asset tag, serial number, device ID or model.',
  placeholder = 'DOE-LN0000001',
  onSelect,
  excludeIds,
  excludeNote,
  autoFocus,
  disabled,
  error,
  scan = false,
}: DevicePickerProps) {
  return (
    <SearchPicker<DeviceSearchResult>
      id={id}
      label={label}
      hint={hint}
      placeholder={placeholder}
      search={searchDevicesAction}
      keyOf={(device) => device.id}
      mono
      renderOption={(device) => (
        <>
          <span className="picker-option-name mono">{device.label}</span>
          <span className="picker-option-meta">
            {device.type}
            {device.model ? `, ${device.model}` : ''}
            {device.holderName
              ? `, held by ${device.holderName}`
              : `, ${device.status.toLowerCase()}`}
          </span>
        </>
      )}
      onSelect={onSelect}
      disabledKeys={excludeIds}
      disabledNote={excludeNote}
      autoFocus={autoFocus}
      disabled={disabled}
      error={error}
      emptyText={(term) => `No device in the inventory matches "${term}".`}
      inputAction={
        scan
          ? (apply) => (
              <ScanTargetButton label="Asset tag" disabled={disabled} onScan={apply} />
            )
          : undefined
      }
    />
  );
}
