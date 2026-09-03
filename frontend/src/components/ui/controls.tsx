import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  const id = useId();
  return (
    <span className="switch">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="track" aria-hidden="true" />
      <span className="thumb" aria-hidden="true" />
    </span>
  );
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  label?: string;
  children: ReactNode;
  onChange?: (value: string) => void;
}

/** Styled native select: keeps OS accessibility & behavior, custom chrome. */
export function SelectField({ label, children, onChange, className = '', ...rest }: SelectFieldProps) {
  const id = useId();
  return (
    <div className="field">
      {label ? <label htmlFor={id} className="field-label">{label}</label> : null}
      <div className="select-wrap">
        <select
          id={id}
          className={'select ' + className}
          onChange={event => onChange?.(event.target.value)}
          {...rest}
        >
          {children}
        </select>
        <span className="chevron" aria-hidden="true"><ChevronDown size={16} /></span>
      </div>
    </div>
  );
}
