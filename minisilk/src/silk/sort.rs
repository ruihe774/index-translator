//! Port of silk/sort.c.

/* Insertion sort (fast for already almost sorted arrays):   */
/* Best case:  O(n)   for an already sorted array            */
/* Worst case: O(n^2) for an inversely sorted array          */
/*                                                           */
/* Shell short:    https://en.wikipedia.org/wiki/Shell_sort  */

/// `a`: unsorted / sorted vector (I/O); `idx`: index vector for the sorted elements (O);
/// `L`: vector length; `K`: number of correctly sorted positions.
pub fn silk_insertion_sort_increasing(a: &mut [i32], idx: &mut [i32], L: i32, K: i32) {
    /* Safety checks */
    debug_assert!(K > 0);
    debug_assert!(L > 0);
    debug_assert!(L >= K);

    /* Write start indices in index vector */
    for i in 0..K {
        idx[i as usize] = i;
    }

    /* Sort vector elements by value, increasing order */
    for i in 1..K {
        let value = a[i as usize];
        let mut j = i - 1;
        while j >= 0 && value < a[j as usize] {
            a[(j + 1) as usize] = a[j as usize]; /* Shift value */
            idx[(j + 1) as usize] = idx[j as usize]; /* Shift index */
            j -= 1;
        }
        a[(j + 1) as usize] = value; /* Write value */
        idx[(j + 1) as usize] = i; /* Write index */
    }

    /* If less than L values are asked for, check the remaining values, */
    /* but only spend CPU to ensure that the K first values are correct */
    for i in K..L {
        let value = a[i as usize];
        if value < a[(K - 1) as usize] {
            let mut j = K - 2;
            while j >= 0 && value < a[j as usize] {
                a[(j + 1) as usize] = a[j as usize]; /* Shift value */
                idx[(j + 1) as usize] = idx[j as usize]; /* Shift index */
                j -= 1;
            }
            a[(j + 1) as usize] = value; /* Write value */
            idx[(j + 1) as usize] = i; /* Write index */
        }
    }
}

/// `a`: unsorted / sorted vector (I/O); `L`: vector length.
pub fn silk_insertion_sort_increasing_all_values_int16(a: &mut [i16], L: i32) {
    /* Safety checks */
    debug_assert!(L > 0);

    /* Sort vector elements by value, increasing order */
    for i in 1..L {
        let value = a[i as usize];
        let mut j = i - 1;
        while j >= 0 && value < a[j as usize] {
            a[(j + 1) as usize] = a[j as usize]; /* Shift value */
            j -= 1;
        }
        a[(j + 1) as usize] = value; /* Write value */
    }
}
