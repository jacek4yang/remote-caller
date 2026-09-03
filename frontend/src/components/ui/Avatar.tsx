import { initialOf } from '../../lib/format';

interface AvatarProps {
  name: string;
  size?: 'sm' | 'md' | 'lg';
}

export function Avatar({ name, size = 'md' }: AvatarProps) {
  const label = name.trim() ? name : '?';
  return (
    <span
      className="avatar"
      data-size={size}
      role="img"
      aria-label={label}
      style={size === 'lg' ? { width: 72, height: 72, fontSize: '1.8rem' } : size === 'sm' ? { width: 30, height: 30, fontSize: '.78rem' } : undefined}
    >
      {initialOf(name)}
    </span>
  );
}
