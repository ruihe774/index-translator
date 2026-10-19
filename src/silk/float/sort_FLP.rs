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

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_insertion_sort_decreasing_FLP(a: *mut f32, idx: *mut i32, L: i32, K: i32);
        }
    }

    #[test]
    fn matches_c() {
        let mut rng = Rng::new(91);
        for _ in 0..500 {
            let l = rng.range(1, 70);
            let k = rng.range(1, l.min(12));
            let mut a = rng.f32_vec(70, 1.0);
            if rng.range(0, 3) == 0 {
                /* ties and sorted/reversed input */
                for v in a.iter_mut() {
                    *v = (*v * 4.0).round();
                }
            }
            if rng.range(0, 5) == 0 {
                a.sort_by(|x, y| y.partial_cmp(x).unwrap());
            }
            let (mut ra, mut ea) = (a.clone(), a.clone());
            let (mut ri, mut ei) = (vec![-1i32; 70], vec![-1i32; 70]);
            super::silk_insertion_sort_decreasing_FLP(&mut ra, &mut ri, l, k);
            unsafe { c::silk_insertion_sort_decreasing_FLP(ea.as_mut_ptr(), ei.as_mut_ptr(), l, k) };
            assert_eq!(ri, ei, "l {l} k {k}");
            for i in 0..70 {
                assert_eq!(ra[i].to_bits(), ea[i].to_bits());
            }
        }
    }
}
