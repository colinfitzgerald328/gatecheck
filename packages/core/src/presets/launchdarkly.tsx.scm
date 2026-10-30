; LaunchDarkly, TypeScript / TSX. Captures are documented in presets/types.ts.

; client.variation('key', fallback)            browser SDK
; client.variation('key', context, fallback)   Node server SDK
; The fallback is the last argument either way.
((call_expression
   function: (member_expression property: (property_identifier) @_method)
   arguments: (arguments . (string) @key (_) @fallback .)) @read
 (#match? @_method "^(variation|boolVariation|stringVariation|numberVariation|jsonVariation)$"))

; client.variationDetail('key', context, fallback).value
((member_expression
   object: (call_expression
     function: (member_expression property: (property_identifier) @_method)
     arguments: (arguments . (string) @key (_) @fallback .))
   property: (property_identifier) @_value) @read
 (#eq? @_method "variationDetail")
 (#eq? @_value "value"))

; useFlags().someFlag
((member_expression
   object: (call_expression function: (identifier) @_fn)
   property: (property_identifier) @key) @read
 (#eq? @_fn "useFlags"))

; props.flags.someFlag and this.props.flags.someFlag, injected by withLDConsumer
((member_expression
   object: (member_expression
     object: (_) @_props
     property: (property_identifier) @_flags)
   property: (property_identifier) @key) @read
 (#eq? @_flags "flags")
 (#match? @_props "(^|\\.)props$"))

; useFlags()
((call_expression function: (identifier) @_fn) @bag
 (#eq? @_fn "useFlags"))
