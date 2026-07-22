import { Input as TelegramInput } from '@telegram-apps/telegram-ui';
import React from 'react';

type Props = React.ComponentProps<typeof TelegramInput> & { label?: string; error?: string };

export const Input: React.FC<Props> = ({ label, error, ...rest }) => (
  <div className="flex flex-col gap-1">
    <TelegramInput header={label} status={error ? 'error' : 'default'} {...rest} />
    {error && <span className="text-xs text-red-400">{error}</span>}
  </div>
);
