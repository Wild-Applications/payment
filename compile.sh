docker build -t wildapps/payment:0.0.1 . &&
kubectl scale --replicas=0 deployment deployment --namespace=payment &&
kubectl scale --replicas=2 deployment deployment --namespace=payment
