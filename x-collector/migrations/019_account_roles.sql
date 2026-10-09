-- Required by collector account selection and the publisher dashboard.
ALTER TABLE x_accounts ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'collector';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='x_accounts'::regclass AND conname='xc_account_role_check') THEN
    ALTER TABLE x_accounts ADD CONSTRAINT xc_account_role_check CHECK (role IN ('collector','publisher'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_x_accounts_role ON x_accounts(role,status);
