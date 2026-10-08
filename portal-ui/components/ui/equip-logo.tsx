import logo from "../../equip-logo.png";

interface EquipLogoProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}
export function EquipLogo({ size = 'md', className = '' }: EquipLogoProps) {
  const dimensions = {
    xs: { width: 78, height: 20 },
    sm: { width: 94, height: 24 },
    md: { width: 125, height: 32 },
    lg: { width: 187, height: 48 },
  }[size];
  return <img src={logo} alt="Equip" width={dimensions.width} height={dimensions.height}
    className={`shrink-0 object-contain ${className}`} />;
}
