import firebase_admin
from firebase_admin import firestore

app = firebase_admin.initialize_app()
db = firestore.client()

try:
    res = db.collection('usuarios').count().get()
    print("RES:", res)
    print("TYPE:", type(res))
    print("RES[0][0].value:", res[0][0].value)
except Exception as e:
    print("ERROR:", e)
