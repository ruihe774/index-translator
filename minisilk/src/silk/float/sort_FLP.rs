//! Port of silk/float/sort_FLP.c.

/* Insertion sort (fast for already almost sorted arrays):  */
/* Best case:  O(n)   for an already sorted array           */
/* Worst case: O(n^2) for an inversely sorted array         */

pub fn silk_insertion_sort_decreasing_FLP(
    a: &mut [f32],  /* I/O  Unsorted / Sorted vector                                    */
    idx: &mut [i32], /* O    Index vector for the sorted elements                        */
    L: i32,         /* I    Vector length                                               */
    K: i32,         /* I    Number of correctly sorted positions                        */
) {
    /* Safety checks */
    debug_assert!(K > 0);
    debug_assert!(L > 0);
    debug_assert!(L >= K);

    /* Write start indices in index vector */
    for i in 0..K {
        idx[i as usize] = i;
    }

    /* Sort vector elements by value, decreasing order */
    for i in 1..K {
        let value: f32 = a[i as usize];
        let mut j = i - 1;
        while j >= 0 && value > a[j as usize] {
            a[(j + 1) as usize] = a[j as usize]; /* Shift value */
            idx[(j + 1) as usize] = idx[j as usize]; /* Shift index */
            j -= 1;
        }
        a[(j + 1) as usize] = value; /* Write value */
        idx[(j + 1) as usize] = i; /* Write index */
    }

    /* If less than L values are asked check the remaining values,      */
    /* but only spend CPU to ensure that the K first values are correct */
    for i in K..L {
        let value: f32 = a[i as usize];
        if value > a[(K - 1) as usize] {
            let mut j = K - 2;
            while j >= 0 && value > a[j as usize] {
                a[(j + 1) as usize] = a[j as usize]; /* Shift value */
                idx[(j + 1) as usize] = idx[j as usize]; /* Shift index */
                j -= 1;
            }
            a[(j + 1) as usize] = value; /* Write value */
            idx[(j + 1) as usize] = i; /* Write index */
        }
    }
}
