import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders agent output.
 *
 * Every agent replies in Markdown: the chat agent for structure, the PDF and
 * PPT agents for their download links, the workspace agent for meeting lists
 * and Meet links. One component handles all of it.
 *
 * remarkGfm adds tables, strikethrough and autolinks, which agents produce
 * often enough that plain CommonMark looks broken without it.
 *
 * The styling lives in index.css under `.md` rather than in classNames here,
 * because react-markdown renders bare HTML tags with no hook to attach to.
 */

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links to generated files and Google Meet should leave the app, and
          // noreferrer keeps the token-bearing URL out of the Referer header.
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          // Loading is lazy because a search result can carry a dozen images.
          img: (props) => <img {...props} loading="lazy" alt={props.alt ?? ""} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
