
type LogoProps = {
    onClick?: () => void;
    className?: string;
    linkProps?: LinkProps; 
    src?: string;
}

type LinkProps = {
    url?: string;
    alt?: string;
    target?: string;
}

export default function Logo({ onClick, className, src, linkProps}: LogoProps) {

    let style = "shrink-0 size-40";
    let urlLink =   linkProps?.url || "/";
    let target =    linkProps?.target || "_blank";
    let alt =       linkProps?.alt || "Logo";
    

    if (className) {
        style = style + " " + className;
    }

    return (
        <a href={urlLink} target={target} onClick={onClick}>
            <img src={src} className={style} alt={alt} />
        </a>
    )
}
