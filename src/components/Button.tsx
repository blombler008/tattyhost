type ButtonProps = {
    children?: React.ReactNode;
    className?: string;
    onClick?: () => void;
    submitProps?: SubmitProps;
}

type SubmitProps = {
    name: string;
    value: string;
}
 
export default function Button({ children, className, onClick, submitProps }: ButtonProps) {

    const style = "theme-panel theme-text min-w-60 cursor-pointer rounded-xl border px-10 py-3 transition hover:border-sky-500 active:opacity-80" + (className ? ' ' + className : '');
    if (submitProps) {
        return (
            <button className={style} type="submit" name={submitProps.name} value={submitProps.value}>{children}</button>
        );
    }

    return (
        <button className={style} onClick={onClick}>{children}</button>
    );
}