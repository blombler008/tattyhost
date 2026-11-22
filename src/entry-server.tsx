import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server' 
import App from './App' 

import type { Request, Response } from 'express';



export function render(url: string, _req: Request, res: Response) {
    const html = renderToString(
        <StrictMode>
            <App ssrAuth={res.locals.ssrAuth} pathname={new URL(url, 'http://localhost').pathname}>
            </App>
        </StrictMode>, 
    )

    const head = '<link rel="stylesheet" href="/src/index.css" />';

    return { html, head }
}
 