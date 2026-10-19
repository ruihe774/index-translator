/* Layout tables: {name, value} pairs ending with a NULL name, read by oracle::layout(). */
#ifndef ORACLE_LAYOUT_H
#define ORACLE_LAYOUT_H
#include <stddef.h>
struct oracle_layout_entry { const char *name; int value; };
#define L_SIZE(T)      { #T, (int)sizeof(T) }
#define L_OFF(T, f)    { #T "." #f, (int)offsetof(T, f) }
#define L_END          { 0, 0 }
#endif
