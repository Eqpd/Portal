interface EquipLogoProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

export function EquipLogo({ size = 'md', className = '' }: EquipLogoProps) {
  const styles = {
    xs: { icon: 'text-lg',  text: 'text-xs',   gap: 'gap-1.5', tracking: 'tracking-[3px]' },
    sm: { icon: 'text-2xl', text: 'text-sm',   gap: 'gap-2',   tracking: 'tracking-[3px]' },
    md: { icon: 'text-3xl', text: 'text-base', gap: 'gap-2',   tracking: 'tracking-[4px]' },
    lg: { icon: 'text-5xl', text: 'text-2xl',  gap: 'gap-3',   tracking: 'tracking-[5px]' },
  }[size];

  return (
    <div className={`flex items-center ${styles.gap} ${className}`}>
      <span className={`${styles.icon} text-indigo-500`} style={{ lineHeight: 1, display: 'inline-block', transform: 'translateY(-1.5px)' }}>⬡</span>
      <span className={`${styles.text} font-black ${styles.tracking} uppercase`} style={{ lineHeight: 1 }}>Equip</span>
    </div>
  );
}
