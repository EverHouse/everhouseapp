import { useEffect, useCallback, useState } from 'react';

interface UseUnsavedChangesOptions {
  isDirty: boolean;
  message?: string;
}

export function useUnsavedChanges({ isDirty, message }: UseUnsavedChangesOptions) {
  const defaultMessage = message || 'You have unsaved changes. Discard changes?';
  const [showDialog, setShowDialog] = useState(false);

  useEffect(() => {
    if (!isDirty) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const confirmDiscard = useCallback(() => {
    setShowDialog(false);
  }, []);

  const cancelDiscard = useCallback(() => {
    setShowDialog(false);
  }, []);

  return {
    showDialog,
    dialogTitle: 'Unsaved Changes',
    dialogMessage: defaultMessage,
    confirmDiscard,
    cancelDiscard,
  };
}
