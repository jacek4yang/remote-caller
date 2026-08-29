interface BrandProps {
  compact?: boolean;
}

export function Brand({ compact = false }: BrandProps) {
  return (
    <div className={'brand' + (compact ? ' compact' : '')}>
      <span className="brand-mark" aria-hidden="true">R</span>
      Remote Caller
    </div>
  );
}
