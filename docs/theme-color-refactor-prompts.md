# Theme Color Refactor — User Prompts

Chronological list of the prompts used to drive the PO-color refactor on
`template.location`. Share with other devs who want to understand the
conversation that produced the changes in `scripts/dev/sync-theme-to-globals.mjs`,
`scripts/04-process-excel-data.mjs`, the Excel template, `src/components/Info.tsx`,
`src/styles/globals.css`, and `tailwind.config.ts`.

---

## 1. Framing the problem

> the repo template.location-sk is a repo to produce websites using a specific
> template for multiple clients. The client data is partly coming from excel
> file, which our project owners fill in at the start of the project, partly
> from ai and partly from google drive folders where we store images and .json
> files. The excel file is what I would like to talk to you about. Currently
> the PO fills in 4 colors: Farbe - Primary Farbe - Primary Vordergrund
> (Schriftfarbe) Farbe - Secondary Farbe - Accent. These colors are used
> in different places within the repository. It is quite unclear to a PO how
> the colors are being used. We need to make it very easy for the PO to
> understand where which color is being used and also limit the number of
> colors to a minimum. Ideally just primary, secondary, accent with the
> respective text-foreground colors. Can you help me think through how we can
> improve the excel file to help the POs pick good colors and understand where
> they are being used?

## 2. Approving the plan & asking about the three coloured cards

> can you implement your suggestions in the excel file regarding the column
> naming and the reduction to two colors and auto-deriving text-on-color. Also
> change the code accordingly. Do not include screenshots or the longer
> descriptions in the excel. One question remains, we had three coloured cards.
> These colors need to be defined somewhere too, or we automatically derive
> them to have the po fill in as few colors as possible

## 3. The left-most card still looks plain

> we need to improve this visual. The cards seem to use the primary and accent
> colors, but please check. For this client especially the card on the far left
> also needs a color I think. How can we best handle this without another color
> in the excel file? [screenshot attached]

## 5. Guarding against washed-out accents

> the problem is that accent/20 is basically white. when accent/20 is too close
> to white, we need to use a different color on the third card in the info
> component

## 6. Documenting provenance in the theme config

> please create a comment in the theme file which very concisely describes how
> the colors come about - as some come from the excel and others are determined
> automatically.
