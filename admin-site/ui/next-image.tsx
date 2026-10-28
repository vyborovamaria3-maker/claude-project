import React from "react";
export default function Image({ unoptimized: _unoptimized, fill: _fill, priority: _priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean; fill?: boolean; priority?: boolean }) {
  return <img {...props}/>;
}
