import React from "react";
export default function Link({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a href={href === "/intelligence" ? "/#graph" : href} {...props}>{children}</a>;
}
