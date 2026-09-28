# Bundled fonts

Liberation Sans, Liberation Serif and Liberation Mono (regular and bold), version 2.1.x, copyright Red Hat, Inc.,
licensed under the SIL Open Font License 1.1 (see `LICENSE`). They are metric-compatible with Arial, Times New Roman
and Courier New.

The connector uses them to convert `<text>` elements in inserted SVG into outlined paths, because Graphite's web build
cannot render text from SVG. Italic is synthesised with a skew. To use other typefaces, put `.ttf` or `.otf` files in
the directory named by `GRAPHITE_MCP_FONT_DIR`; they are matched by family name.
