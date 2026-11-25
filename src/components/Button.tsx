import type { ComponentPropsWithoutRef } from 'react';

type ButtonVariant = 'primary' | 'normal' | 'danger' | 'ghost' | 'icon' | 'tab';

const baseClass = 'inline-flex items-center justify-center gap-2 text-sm font-medium transition duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 motion-reduce:transition-none';
const variantClasses: Record<ButtonVariant, string> = {
    primary: 'min-h-10 rounded-xl bg-sky-300 px-4 py-2 font-semibold text-slate-950 hover:bg-sky-200 active:scale-[0.98]',
    normal: 'min-h-10 rounded-xl border border-[var(--theme-border)] px-3 py-2 theme-text hover:border-sky-400/60 hover:bg-sky-400/10 active:scale-[0.98]',
    danger: 'min-h-10 rounded-xl px-3 py-2 text-rose-300 hover:bg-rose-500/10 active:scale-[0.98] focus-visible:outline-rose-500',
    ghost: 'min-h-10 rounded-xl px-3 py-2 theme-text hover:bg-[var(--theme-section)] active:scale-[0.98]',
    icon: 'min-h-10 min-w-10 shrink-0 rounded-xl p-2 theme-text hover:bg-[var(--theme-section)] aria-expanded:bg-[var(--theme-section)] active:scale-[0.98]',
    tab: 'shrink-0 border-b-2 border-transparent px-4 py-3 theme-muted hover:bg-[var(--theme-section)] hover:text-sky-200 aria-selected:border-sky-300 aria-selected:text-[var(--theme-text)] focus-visible:outline-offset-[-2px]'
};

function buttonClass(variant: ButtonVariant = 'normal', className = '') {
    return `${baseClass} ${variantClasses[variant]} ${className}`;
}

type ButtonProps = ComponentPropsWithoutRef<'button'> & { variant?: ButtonVariant };

export default function Button({ variant = 'normal', className, ...props }: ButtonProps) {
    return <button className={`${buttonClass(variant, className)} disabled:cursor-not-allowed disabled:opacity-50`} {...props} />;
}

type ButtonLinkProps = ComponentPropsWithoutRef<'a'> & { variant?: ButtonVariant };

export function ButtonLink({ variant = 'normal', className, ...props }: ButtonLinkProps) {
    return <a className={buttonClass(variant, className)} {...props} />;
}
