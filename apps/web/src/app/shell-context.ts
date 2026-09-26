import { useOutletContext } from 'react-router';
import type { ShellDialog } from '../components/layout/AppShell';

export function useShellDialogs(): (d: ShellDialog) => void {
  return useOutletContext<{ openShellDialog: (d: ShellDialog) => void }>().openShellDialog;
}
