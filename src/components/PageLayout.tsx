export interface PageLayoutProps {
  children: React.ReactNode;
}

/** Wraps page content. JSON-LD is injected by Astro layouts for zero-JS. */
export const PageLayout = ({ children }: PageLayoutProps) => {
  return <>{children}</>;
};
