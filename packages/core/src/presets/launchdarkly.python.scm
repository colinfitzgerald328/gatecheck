; LaunchDarkly, Python. Captures are documented in presets/types.ts.

; client.variation('key', context, default) and ldclient.get().variation(...)
((call
   function: (attribute attribute: (identifier) @_method)
   arguments: (argument_list . (string) @key (_) @fallback .)) @read
 (#eq? @_method "variation"))

; client.variation_detail('key', context, default).value
((attribute
   object: (call
     function: (attribute attribute: (identifier) @_method)
     arguments: (argument_list . (string) @key (_) @fallback .))
   attribute: (identifier) @_value) @read
 (#eq? @_method "variation_detail")
 (#eq? @_value "value"))
