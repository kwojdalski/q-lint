/ A multiline string. q continues a line onto the next when that one is
/ indented, so the closing quote has to be indented too - at column 0 it
/ would start a new statement and leave the string unterminated.
.hk.extrausage: "Housekeeping:\n
	This process removes and zips files older than a given date.
	It is extended through user functions added to this script.
	Calling hkrun[] runs the service immediately.
	The process can be driven from the timer in the config file.
	
	[function]		rm for remove, zip for gzip
	[path]		the directory to act on
	"

/ The `if[` below is what a rule once matched, having stepped over every
/ blanked-out line of the string above to reach it.
if[`hkusage in key .Q.opt .z.x; -1 .hk.extrausage];
